// File: apps/range-api/test/units.test.ts
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrokerClient, unixJson } from '../src/brokerClient.ts';
import { InFlight, SlidingWindow } from '../src/rateLimit.ts';
import { SessionBook } from '../src/sessionBook.ts';
import { SseHub } from '../src/sse.ts';

describe('SlidingWindow', () => {
  it('lets the window slide: hits older than the window stop counting', () => {
    let t = 0;
    const w = new SlidingWindow(2, 1000, () => t);
    expect(w.take('a').ok).toBe(true);
    expect(w.take('a').ok).toBe(true);
    const blocked = w.take('a');
    expect(blocked).toEqual({ ok: false, retryAfterS: 1 });
    t = 1001;
    expect(w.take('a').ok).toBe(true);
  });
  it('keeps keys independent', () => {
    const w = new SlidingWindow(1, 1000, () => 0);
    expect(w.take('a').ok).toBe(true);
    expect(w.take('b').ok).toBe(true);
    expect(w.take('a').ok).toBe(false);
  });
});

describe('InFlight', () => {
  it('refuses past the max and never goes below zero', () => {
    const f = new InFlight(1);
    expect(f.tryEnter()).toBe(true);
    expect(f.tryEnter()).toBe(false);
    f.leave(); f.leave();
    expect(f.count).toBe(0);
  });
});

describe('SseHub', () => {
  it('replays events after Last-Event-ID and trims the buffer to 200', () => {
    const hub = new SseHub();
    for (let i = 0; i < 205; i++) hub.publish('s', 'x', i);
    const got: number[] = [];
    hub.subscribe('s', (e) => got.push(e.id), 203);
    expect(got).toEqual([204, 205]);
    const all: number[] = [];
    hub.subscribe('s', (e) => all.push(e.id), 0);
    expect(all).toHaveLength(200);
  });
  it('formats an event and stops delivering after unsubscribe or drop', () => {
    const hub = new SseHub();
    const got: string[] = [];
    const off = hub.subscribe('s', (e) => got.push(SseHub.format(e)));
    hub.publish('s', 'verdict', { a: 1 });
    expect(got[0]).toBe('id: 1\nevent: verdict\ndata: {"a":1}\n\n');
    off();
    hub.publish('s', 'verdict', {});
    expect(got).toHaveLength(1);
    hub.drop('s');
    const replay: number[] = [];
    hub.subscribe('s', (e) => replay.push(e.id));
    expect(replay).toEqual([]);
  });
});

describe('SessionBook', () => {
  it('checks the key in constant time terms: right key OK, wrong key mismatch, none required, unknown session', () => {
    const b = new SessionBook();
    const { key } = b.register('abcdef01', '1.1.1.1');
    expect(b.check('abcdef01', key)).toBe('OK');
    expect(b.check('abcdef01', 'wrong')).toBe('KEY_MISMATCH');
    expect(b.check('abcdef01', undefined)).toBe('KEY_REQUIRED');
    expect(b.check('abcdef01', '')).toBe('KEY_REQUIRED');
    expect(b.check('00000000', key)).toBe('SESSION_UNKNOWN');
    expect(b.check(5, key)).toBe('SESSION_UNKNOWN');
  });
  it('groups sessions by creating address and forgets them after the ttl', () => {
    let t = 0;
    const b = new SessionBook(1000, () => t);
    b.register('aaaaaaa1', '1.1.1.1');
    b.register('aaaaaaa2', '1.1.1.1');
    b.register('bbbbbbb1', '2.2.2.2');
    expect(b.sessionsOf('1.1.1.1')).toEqual(['aaaaaaa1', 'aaaaaaa2']);
    t = 1500;
    expect(b.register('ccccccc1', '3.3.3.3').expired.sort()).toEqual(['aaaaaaa1', 'aaaaaaa2', 'bbbbbbb1']);
    expect(b.has('aaaaaaa1')).toBe(false);
  });
  it('accepts only 8 lowercase hex characters as a session id', () => {
    for (const ok of ['0123abcd', 'ffffffff']) expect(SessionBook.isSessionId(ok)).toBe(true);
    for (const bad of ['0123ABCD', '0123abc', '0123abcde', 'sess00000001', 5, null]) expect(SessionBook.isSessionId(bad)).toBe(false);
  });
});

describe('unix socket client', () => {
  function withServer(handler: http.RequestListener): Promise<{ path: string; close: () => Promise<void> }> {
    const dir = mkdtempSync(join(tmpdir(), 'plb-api-'));
    const path = join(dir, 's.sock');
    const server = http.createServer(handler);
    return new Promise((resolve) => server.listen(path, () => resolve({
      path,
      close: () => new Promise<void>((done) => server.close(() => { rmSync(dir, { recursive: true, force: true }); done(); })),
    })));
  }

  it('sends the api token and JSON body, and parses the JSON answer', async () => {
    let seen = '';
    const s = await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen = `${req.method} ${req.url} ${req.headers['x-plumbline-api-token']} ${body}`; res.end(JSON.stringify({ ok: 1 })); });
    });
    try {
      const r = await new BrokerClient(s.path, 'tok').call('POST', '/v1/x', { a: 1 });
      expect(r).toEqual({ status: 200, json: { ok: 1 } });
      expect(seen).toBe('POST /v1/x tok {"a":1}');
    } finally { await s.close(); }
  });

  it('returns the raw text when the answer is not JSON, and rejects when the socket is missing', async () => {
    const s = await withServer((_req, res) => res.end('plain'));
    try {
      expect((await unixJson(s.path, 'GET', '/', {})).json).toBe('plain');
    } finally { await s.close(); }
    await expect(unixJson('/nonexistent/x.sock', 'GET', '/', {})).rejects.toThrow();
  });

  it('chat and mint map broker failures to the operator busy and task errors', async () => {
    const s = await withServer((req, res) => { res.statusCode = req.url === '/v1/llm' ? 503 : 404; res.end('{"status":"NO"}'); });
    try {
      const c = new BrokerClient(s.path, 't');
      await expect(c.chat('s', 'planner', [])).rejects.toThrow('OPERATOR_BUSY');
      await expect(c.mint('s', 'm')).rejects.toThrow('TASK_404_NO');
    } finally { await s.close(); }
  });
});
