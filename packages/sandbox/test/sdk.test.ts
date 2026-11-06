import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const IMAGE_DIR = fileURLToPath(new URL('../image/', import.meta.url));
type Reply = { status: number; body: string; headers?: Record<string, string> };
let reply: Reply = { status: 200, body: '{}' };
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Runs one SDK call in a fresh interpreter pointed at the stub and returns "ok:<json>" or "<ExceptionClass>:<msg>". */
function sdk(call: string, p = port): Promise<string> {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(IMAGE_DIR)})`,
    'import plumbline_sdk as v',
    `v._GATE_HOST = "127.0.0.1"; v._GATE_PORT = ${p}; v._SOCKET_PATH = "/nonexistent/plb.sock"`,
    'v.configure("plbt.a.b")',
    'try:',
    `    r = ${call}`,
    '    print("ok:" + json.dumps(r))',
    'except v.PlumblineError as e:',
    '    print(type(e).__name__ + ":" + str(e))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('python3', ['-B', '-c', script], { timeout: 15000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout.trim())));
  });
}

const allow = (extra: object = {}) => JSON.stringify({ status: 'DECIDED', decision: { decision: 'ALLOW', rule_id: 'r', layer: 'session', reason: 'ok', decision_id: 'd' }, ...extra });

describe('plumbline_sdk _call', () => {
  it('returns the result of an ALLOW (and None only when the broker really returned no result)', async () => {
    reply = { status: 200, body: allow({ result: [{ id: 'i1' }] }) };
    expect(await sdk('v.instances.list()')).toBe('ok:[{"id": "i1"}]');
    reply = { status: 200, body: allow() };
    expect(await sdk('v.instances.delete("x")')).toBe('ok:null');
  });
  it('maps DENY and ESCALATE to PolicyDenied / EscalationRequired with the rule id', async () => {
    reply = { status: 200, body: JSON.stringify({ decision: { decision: 'DENY', rule_id: 'protect-tagged-destroy', layer: 'session', reason: 'x' } }) };
    expect(await sdk('v.instances.delete("x")')).toContain('PolicyDenied:DENY protect-tagged-destroy');
    reply = { status: 200, body: JSON.stringify({ decision: { decision: 'ESCALATE', rule_id: 'esc', layer: 'session', reason: 'x' } }) };
    expect(await sdk('v.bucket.delete("orders.json")')).toContain('EscalationRequired:ESCALATE esc');
  });
  for (const [status, body, cls] of [
    [401, '{"status":"AUTH_TASK_TOKEN_INVALID"}', 'AuthError'],
    [400, '{"status":"ARGS_INVALID","errors":["bad verb"]}', 'ArgsInvalid'],
    [413, '', 'PayloadTooLarge'],
    [429, '{"status":"RATE_LIMITED"}', 'RateLimited'],
    [502, '{"status":"BROKER_UNREACHABLE"}', 'BrokerUnavailable'],
    [500, 'Internal Server Error', 'BrokerUnavailable'],
    [503, '', 'BrokerUnavailable'],
    [404, '{"status":"NOT_ROUTED"}', 'BrokerUnavailable'],
    [302, '', 'BrokerUnavailable'],
  ] as const) {
    it(`AG4-SBX-6 HTTP ${status} raises ${cls}, never a None result`, async () => {
      reply = { status, body };
      expect(await sdk('v.instances.list()')).toMatch(new RegExp(`^${cls}:`));
    });
  }
  it('AG4-SBX-6 a 400 with a non-JSON body is still ArgsInvalid', async () => {
    reply = { status: 400, body: 'oops' };
    expect(await sdk('v.instances.list()')).toMatch(/^ArgsInvalid:/);
  });
  it('AG4-SBX-6 a 200 with a non-JSON body is BrokerProtocolError', async () => {
    reply = { status: 200, body: '<html>proxy page</html>' };
    expect(await sdk('v.instances.list()')).toMatch(/^BrokerProtocolError:/);
  });
  it('AG4-SBX-6 a 200 JSON body that is not the envelope (array, no decision, unknown decision) is BrokerProtocolError', async () => {
    for (const body of ['[]', '{}', 'null', '{"result":[1]}', '{"decision":{"decision":"MAYBE"}}']) {
      reply = { status: 200, body };
      expect(await sdk('v.instances.list()'), body).toMatch(/^BrokerProtocolError:/);
    }
  });
  it('AG4-SBX-6 an oversize body is BrokerProtocolError', async () => {
    reply = { status: 200, body: JSON.stringify({ decision: { decision: 'ALLOW' }, result: 'x'.repeat(300 * 1024) }) };
    expect(await sdk('v.instances.list()')).toMatch(/^BrokerProtocolError:.*larger/);
  });
  it('a broker-side execution error is a PlumblineError carrying the code', async () => {
    reply = { status: 200, body: allow({ error: { code: 'VULTR_429', message: 'slow down' } }) };
    expect(await sdk('v.instances.list()')).toBe('PlumblineError:VULTR_429: slow down');
  });
  it('AG4-SBX-6 no listener at all is BrokerUnreachable', async () => {
    expect(await sdk('v.instances.list()', 1)).toMatch(/^BrokerUnreachable:/);
  });
  it('a call without a configured token never leaves the process', async () => {
    const out = await new Promise<string>((resolve) => execFile('python3', ['-B', '-c', `import sys\nsys.path.insert(0, ${JSON.stringify(IMAGE_DIR)})\nimport plumbline_sdk as v\ntry:\n    v.instances.list()\nexcept v.AuthError as e:\n    print("AuthError:" + str(e))`], (_e, stdout) => resolve(stdout.trim())));
    expect(out).toBe('AuthError:no task token');
  });
  it('the module attribute http is the SDK client, and the stdlib import is not shadowed by it', async () => {
    reply = { status: 200, body: allow({ result: { status: 200 } }) };
    expect(await sdk('v.http.get("http://range.plumbline.local/pages/x")')).toBe('ok:{"status": 200}');
  });
});
