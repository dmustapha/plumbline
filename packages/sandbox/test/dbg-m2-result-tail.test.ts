// DBG-S-M2: the 64 KB stdout cap must not drop the trailing PLB_RESULT line (egress attempts and harness_error live there).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxRunner, boundedCapture, dockerExec } from '../src/index.ts';

const TRAILER = `PLB_RESULT:${JSON.stringify({ ok: false, error: 'boom', attempts: [{ addr: '1.1.1.1:80', completed: false }] })}`;

describe('DBG-S-M2 boundedCapture', () => {
  it('DBG-S-M2: output under the cap is returned untouched', () => {
    const c = boundedCapture(100, 20);
    c.push('abc'); c.push('def');
    expect(c.text()).toBe('abcdef');
  });
  it('DBG-S-M2: over the cap keeps the head and the last bytes, and stays bounded', () => {
    const c = boundedCapture(100, 20);
    for (let i = 0; i < 50; i++) c.push('x'.repeat(40));
    c.push('TAIL-END');
    const t = c.text();
    expect(t.startsWith('x'.repeat(80))).toBe(true);
    expect(t.endsWith('TAIL-END')).toBe(true);
    expect(t).toContain('[truncated]');
    expect(t.length).toBeLessThan(140);
  });
});

describe('DBG-S-M2 a 70 KB printer still reports its egress attempts', () => {
  const saved = process.env.PATH;
  afterEach(() => { process.env.PATH = saved; });

  it('DBG-S-M2: PLB_RESULT after 70 KB of output is parsed (attempts kept, harness_error kept)', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'plb-fakedocker-'));
    const script = `#!/bin/sh
case "$1" in
  run) head -c 70000 /dev/zero | tr '\\0' 'x'; printf '\\n'; printf '%s\\n' '${TRAILER}';;
  inspect) exit 1;;
  *) exit 0;;
esac
`;
    writeFileSync(join(bin, 'docker'), script);
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}:${saved ?? ''}`;
    const res = await new SandboxRunner(dockerExec, null, async () => undefined).run({ code: 'print(1)', token: 't' });
    expect(res.attempts).toEqual([{ addr: '1.1.1.1:80', completed: false }]);
    expect(res.harness_error).toBe('boom');
    expect(res.stdout.length).toBeLessThanOrEqual(32 * 1024);
  });
});
