import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RELAY = fileURLToPath(new URL('../gate/relay.mjs', import.meta.url));
let upstream: http.Server;
let relay: ChildProcess;
let relayPort = 0;
const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  relayPort = await freePort();
  const env = { PATH: process.env.PATH ?? '', GATE_UPSTREAM_HOST: '127.0.0.1', GATE_UPSTREAM_PORT: String((upstream.address() as AddressInfo).port), GATE_LISTEN_PORT: String(relayPort) };
  relay = spawn(process.execPath, [RELAY], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    relay.stdout?.on('data', (d: Buffer) => { if (d.toString().includes('listening')) resolve(); });
    relay.on('error', reject);
    setTimeout(() => reject(new Error('relay did not start')), 8000);
  });
});

afterAll(async () => {
  relay.kill('SIGKILL');
  await new Promise<void>((r) => upstream.close(() => r()));
});

const hit = (path: string, method = 'GET', body?: string) => fetch(`http://127.0.0.1:${relayPort}${path}`, { method, body, headers: body ? { authorization: 'Bearer plbt.a.b', 'content-type': 'application/json' } : {} });

describe('plb-gate relay', () => {
  it('forwards POST /v1/call with the bearer token and body, and GET /healthz', async () => {
    const r = await hit('/v1/call', 'POST', '{"verb":"list"}');
    expect(r.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/v1/call', auth: 'Bearer plbt.a.b', body: '{"verb":"list"}' });
    expect((await hit('/healthz')).status).toBe(200);
  });
  it('routes nothing else: other paths and methods are NOT_ROUTED and never reach the broker', async () => {
    const before = seen.length;
    for (const [p, m] of [['/v1/status', 'GET'], ['/v1/call', 'GET'], ['/healthz', 'POST'], ['/admin', 'POST'], ['/v1/call/../x', 'POST']] as const) {
      const r = await hit(p, m, m === 'POST' ? '{}' : undefined);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect(seen.length).toBe(before);
  });
  it('refuses a body over 16 KiB with 413 and does not forward it', async () => {
    const before = seen.length;
    const r = await hit('/v1/call', 'POST', 'x'.repeat(40 * 1024));
    expect(r.status).toBe(413);
    expect(seen.length).toBe(before);
  });
});

describe('plb-gate relay with the broker down', () => {
  it('answers 502 BROKER_UNREACHABLE', async () => {
    const dead = await freePort();
    const port = await freePort();
    const env = { PATH: process.env.PATH ?? '', GATE_UPSTREAM_HOST: '127.0.0.1', GATE_UPSTREAM_PORT: String(dead), GATE_LISTEN_PORT: String(port) };
    const child = spawn(process.execPath, [RELAY], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => child.stdout?.on('data', (d: Buffer) => { if (d.toString().includes('listening')) resolve(); }));
      const r = await fetch(`http://127.0.0.1:${port}/v1/call`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ status: 'BROKER_UNREACHABLE' });
    } finally {
      child.kill('SIGKILL');
    }
  });
});
