import { describe, expect, it } from 'vitest';
import type { SandboxRunner } from '@plumbline/sandbox';
import { buildRunnerApp, transportFromEnv } from '../src/main.ts';

const fakeRunner = (delayMs = 0, seen: unknown[] = []) => ({
  run: async (req: unknown) => { seen.push(req); await new Promise((r) => setTimeout(r, delayMs)); return { state: 'OK', destroyed: true }; },
  listContainers: async () => [],
}) as unknown as SandboxRunner;
const H = { 'x-plumbline-runner-token': 'tok' };
const post = (app: ReturnType<typeof buildRunnerApp>, payload: unknown) => app.inject({ method: 'POST', url: '/run', headers: H, payload: payload as object });

describe('runner daemon', () => {
  it('requires the token', async () => {
    const app = buildRunnerApp(fakeRunner(), 'tok');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-plumbline-runner-token': 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-plumbline-runner-token': 'toolongtoken' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: H })).statusCode).toBe(200);
  });
  it('a missing or wrong token never reaches the runner', async () => {
    const seen: unknown[] = [];
    const app = buildRunnerApp(fakeRunner(0, seen), 'tok');
    expect((await app.inject({ method: 'POST', url: '/run', payload: { code: 'print(1)', token: 't' } })).statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });
  it('rejects malformed bodies and oversized code', async () => {
    const app = buildRunnerApp(fakeRunner(), 'tok');
    expect((await post(app, { code: 1 })).statusCode).toBe(400);
    expect((await post(app, { code: 'x'.repeat(20001), token: 't' })).statusCode).toBe(400);
    expect((await post(app, { code: 'print(1)', token: 't'.repeat(2049) })).statusCode).toBe(400);
  });
  it('AG4-SBX-8 limits null, an array, a string or non-numeric members are ARGS_INVALID (400), not a 500', async () => {
    const seen: unknown[] = [];
    const app = buildRunnerApp(fakeRunner(0, seen), 'tok');
    for (const limits of [null, [], 'big', { mem_mb: 'lots' }, { pids: null }, { wall_s: Number.NaN }]) {
      const r = await app.inject({ method: 'POST', url: '/run', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ code: 'print(1)', token: 't', limits }) });
      expect(r.statusCode, JSON.stringify(limits)).toBe(400);
      expect(r.json()).toEqual({ status: 'ARGS_INVALID' });
    }
    expect(seen).toHaveLength(0);
  });
  it('valid partial limits and an absent limits member pass through', async () => {
    const seen: unknown[] = [];
    const app = buildRunnerApp(fakeRunner(0, seen), 'tok');
    expect((await post(app, { code: 'print(1)', token: 't' })).statusCode).toBe(200);
    expect((await post(app, { code: 'print(1)', token: 't', limits: { wall_s: 5 } })).statusCode).toBe(200);
    expect(seen).toHaveLength(2);
  });
  it('returns RUNNER_BUSY above the concurrency cap', async () => {
    const app = buildRunnerApp(fakeRunner(80), 'tok', 1);
    const a = app.inject({ method: 'POST', url: '/run', headers: H, payload: { code: 'print(1)', token: 't' } });
    await new Promise((r) => setTimeout(r, 10));
    const b = await app.inject({ method: 'POST', url: '/run', headers: H, payload: { code: 'print(2)', token: 't' } });
    expect(b.statusCode).toBe(429);
    expect((await a).statusCode).toBe(200);
  });
});

describe('transportFromEnv', () => {
  it('defaults to the relay, accepts the socket fallback with a directory, refuses anything else', () => {
    expect(transportFromEnv({})).toEqual({ kind: 'relay' });
    expect(transportFromEnv({ PLUMBLINE_SANDBOX_TRANSPORT: 'socket', PLUMBLINE_SANDBOX_SOCKET_DIR: '/run/plumbline-sbx' })).toEqual({ kind: 'socket', socketDir: '/run/plumbline-sbx' });
    expect(() => transportFromEnv({ PLUMBLINE_SANDBOX_TRANSPORT: 'socket' })).toThrow(/BOOT_REFUSED/);
    expect(() => transportFromEnv({ PLUMBLINE_SANDBOX_TRANSPORT: 'host' })).toThrow(/BOOT_REFUSED/);
  });
});
