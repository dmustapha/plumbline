import { chmodSync, rmSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { SandboxRunner, isLimitsInput, type Limits, type SandboxTransport } from '@plumbline/sandbox';

const MAX_CODE = 20000;
const MAX_TOKEN = 2048;

export function buildRunnerApp(runner: SandboxRunner, token: string, maxConcurrent = 2) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  let active = 0;
  const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  app.addHook('onRequest', async (req, reply) => {
    if (!same(String(req.headers['x-plumbline-runner-token'] ?? ''), token)) await reply.code(401).send({ status: 'AUTH_RUNNER_INVALID' });
  });
  app.get('/healthz', async () => ({ ok: true, active }));
  app.get('/containers', async () => ({ containers: await runner.listContainers() }));
  app.post<{ Body: { code: string; token: string; limits?: Partial<Limits> } }>('/run', async (req, reply) => {
    const b = req.body;
    // AG4-SBX-8: limits may be absent or an object of finite numbers; null, arrays and strings are refused before docker is involved.
    if (!b || typeof b !== 'object' || typeof b.code !== 'string' || b.code.length > MAX_CODE || typeof b.token !== 'string' || b.token.length > MAX_TOKEN || !isLimitsInput(b.limits)) {
      return reply.code(400).send({ status: 'ARGS_INVALID' });
    }
    if (active >= maxConcurrent) return reply.code(429).send({ status: 'RUNNER_BUSY' });
    active += 1;
    try {
      return await runner.run({ code: b.code, token: b.token, limits: b.limits });
    } finally {
      active -= 1;
    }
  });
  return app;
}

/** relay (default, ADR-005) or the U-4 fallback; anything else refuses to boot. */
export function transportFromEnv(env: NodeJS.ProcessEnv): SandboxTransport {
  const kind = env.PLUMBLINE_SANDBOX_TRANSPORT || 'relay';
  if (kind === 'relay') return { kind: 'relay' };
  if (kind === 'socket' && env.PLUMBLINE_SANDBOX_SOCKET_DIR) return { kind: 'socket', socketDir: env.PLUMBLINE_SANDBOX_SOCKET_DIR };
  throw new Error(`BOOT_REFUSED: PLUMBLINE_SANDBOX_TRANSPORT=${kind} needs relay, or socket with PLUMBLINE_SANDBOX_SOCKET_DIR`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const token = process.env.PLUMBLINE_RUNNER_TOKEN;
  if (!token) throw new Error('BOOT_REFUSED: PLUMBLINE_RUNNER_TOKEN missing');
  const socketPath = process.env.PLUMBLINE_RUNNER_SOCKET ?? '/run/plumbline/runner.sock';
  const transport = transportFromEnv(process.env);
  const runner = new SandboxRunner(undefined, process.env.PLUMBLINE_SANDBOX_RUNTIME || null, undefined, transport);
  const swept = await runner.sweepStrays();
  const app = buildRunnerApp(runner, token);
  rmSync(socketPath, { force: true });
  process.umask(0o117);
  await app.listen({ path: socketPath });
  chmodSync(socketPath, 0o660);
  console.log(JSON.stringify({ evt: 'runner-listening', socketPath, swept_strays: swept, runtime: process.env.PLUMBLINE_SANDBOX_RUNTIME || 'runc', transport: transport.kind }));
}
