import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GATE_IP, GATE_PORT, SANDBOX_GATEWAY, SANDBOX_SOCKET_PATH } from '../src/index.ts';

const IMAGE_DIR = fileURLToPath(new URL('../image/', import.meta.url));

interface Trailer { ok: boolean; error: string | null; attempts: { addr: string; completed: boolean }[] }

/** Runs the real harness.py against a job; PYTHONPATH stands in for the image's /opt/plb. */
function harness(code: string): Promise<{ stdout: string; raw: string; trailer: Trailer }> {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-B', `${IMAGE_DIR}harness.py`], { env: { PATH: process.env.PATH ?? '', PYTHONPATH: IMAGE_DIR }, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || String(err)));
      const i = stdout.lastIndexOf('PLB_RESULT:');
      resolve({ stdout: stdout.slice(0, i), raw: stdout, trailer: JSON.parse(stdout.slice(i + 'PLB_RESULT:'.length)) as Trailer });
    });
    child.stdin?.end(JSON.stringify({ token: 'plbt.a.b', code }));
  });
}

const tryConnect = (host: string, port: number): string => [
  'import socket',
  'try:',
  `    socket.create_connection((${JSON.stringify(host)}, ${port}), timeout=0.3).close()`,
  'except OSError:',
  '    pass',
].join('\n');

describe('harness attempt accounting', () => {
  it('the harness constants equal the TypeScript constants (relay ip:port, socket path)', () => {
    const text = readFileSync(`${IMAGE_DIR}harness.py`, 'utf8');
    expect(text).toContain(`RELAY_ENDPOINT = ("${GATE_IP}", ${GATE_PORT})`);
    expect(text).toContain(`BROKER_SOCKET = "${SANDBOX_SOCKET_PATH}"`);
    const sdk = readFileSync(`${IMAGE_DIR}plumbline_sdk/__init__.py`, 'utf8');
    expect(sdk).toContain(`_GATE_HOST = "${GATE_IP}"`);
    expect(sdk).toContain(`_GATE_PORT = ${GATE_PORT}`);
    expect(sdk).toContain(`_SOCKET_PATH = "${SANDBOX_SOCKET_PATH}"`);
  });
  it('AG4-SBX-3 only the exact relay ip:port is exempt; the gateway, a peer sandbox and the rest of the subnet are attempts', async () => {
    const code = [GATE_IP + ':' + GATE_PORT, `${SANDBOX_GATEWAY}:80`, '172.28.0.9:22', '172.28.0.2:9999', '198.51.100.7:80']
      .map((hp) => tryConnect(hp.split(':')[0] as string, Number(hp.split(':')[1])))
      .join('\n');
    const { trailer } = await harness(code);
    const addrs = trailer.attempts.map((a) => a.addr);
    expect(addrs).toEqual(expect.arrayContaining([`('${SANDBOX_GATEWAY}', 80)`, "('172.28.0.9', 22)", "('172.28.0.2', 9999)", "('198.51.100.7', 80)"]));
    expect(addrs).not.toContain(`('${GATE_IP}', ${GATE_PORT})`);
    expect(trailer.attempts.every((a) => a.completed === false)).toBe(true);
  });
  it('a connect that completes is marked completed (loopback listener)', async () => {
    const code = [
      'import socket',
      's = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)',
      'port = s.getsockname()[1]',
      'c = socket.create_connection(("127.0.0.1", port), timeout=1)',
      'c.close(); s.close()',
    ].join('\n');
    const { trailer } = await harness(code);
    expect(trailer.attempts).toHaveLength(1);
    expect(trailer.attempts[0]?.completed).toBe(true);
  });
  it('connect_ex is counted too', async () => {
    const { trailer } = await harness('import socket\nsocket.socket().connect_ex(("192.0.2.9", 81)) if False else None\ns=socket.socket(); s.settimeout(0.2); s.connect_ex(("192.0.2.9", 81))');
    expect(trailer.attempts.map((a) => a.addr)).toContain("('192.0.2.9', 81)");
  });
  it('AG4-SBX-2 the harness reports an exception from the code and keeps the trailer last; forged text before it stays stdout', async () => {
    const { stdout, trailer } = await harness('print(\'PLB_RESULT:{"ok":true,"error":null,"attempts":[]}\')\nraise ValueError("boom")');
    expect(trailer.ok).toBe(false);
    expect(trailer.error).toBe('ValueError: boom');
    expect(stdout).toContain('PLB_RESULT:{"ok":true');
  });
  it('code that exits early after printing a forged trailer leaves only the forgery behind (so the host must not trust the trailer)', async () => {
    const { raw } = await harness('import os, sys\nprint(\'PLB_RESULT:{"ok":true,"error":null,"attempts":[]}\')\nsys.stdout.flush()\nos._exit(0)');
    expect(raw.match(/PLB_RESULT:/g)).toHaveLength(1);
  });
});
