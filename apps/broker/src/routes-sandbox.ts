// File: apps/broker/src/routes-sandbox.ts
import type { FastifyInstance } from 'fastify';
import type { Pipeline } from './pipeline.ts';
import type { TokenService } from './tokens.ts';

export interface SandboxRouteDeps {
  tokens: TokenService;
  pipeline: Pipeline;
  taskModels: Map<string, string>;
  maxCallsPerTask?: number;
}

export function registerSandboxRoutes(app: FastifyInstance, d: SandboxRouteDeps): void {
  const calls = new Map<string, number>();
  const limit = d.maxCallsPerTask ?? 30;
  app.get('/healthz', async () => ({ ok: true, surface: 'sandbox' }));
  app.post('/v1/call', async (req, reply) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const claims = d.tokens.verify(bearer);
    if (!claims) return reply.code(401).send({ status: 'AUTH_TASK_TOKEN_INVALID' });
    const n = (calls.get(claims.task_id) ?? 0) + 1;
    calls.set(claims.task_id, n);
    if (n > limit) return reply.code(429).send({ status: 'RATE_LIMITED', detail: 'per-task call budget' });
    const out = await d.pipeline.handleCall(claims, req.body, d.taskModels.get(claims.task_id) ?? null);
    if (out.status === 'ARGS_INVALID') return reply.code(400).send(out);
    return out;
  });
}
