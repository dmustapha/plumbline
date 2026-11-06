// File: packages/sandbox/test/no-credential.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSandboxSocketDir, buildRunArgs, clampLimits } from '../src/index.ts';

describe('no_credential_in_sandbox (static layer)', () => {
  const args = buildRunArgs({ name: 'plb-sbx-x', limits: clampLimits() });
  it('emits every hardening flag and no env, mount or privilege flag', () => {
    for (const flag of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '--memory', '--cpus', '--network']) expect(args).toContain(flag);
    for (const bad of ['-e', '--env', '--env-file', '-v', '--volume', '--mount', '--privileged', '-p', '--publish', '--pid', '--cap-add']) expect(args).not.toContain(bad);
    expect(args.join(' ')).not.toContain('docker.sock');
  });
  it('AG4-SBX-5 the relay form joins the internal network and never mounts anything', () => {
    expect(args.join(' ')).toContain('--network plb-sbx-net');
    expect(args).not.toContain('--mount');
  });
  it('AG4-SBX-5 the socket fallback form is --network none plus exactly one read-only mount of the dedicated directory', () => {
    const fb = buildRunArgs({ name: 'plb-sbx-x', limits: clampLimits(), transport: { kind: 'socket', socketDir: '/run/plumbline-sbx' } });
    expect(fb.join(' ')).toContain('--network none');
    expect(fb.filter((a) => a === '--mount')).toHaveLength(1);
    expect(fb[fb.indexOf('--mount') + 1]).toBe('type=bind,src=/run/plumbline-sbx,dst=/run/plb,readonly');
    for (const bad of ['-e', '--env', '--env-file', '-v', '--volume', '--privileged', '-p', '--publish', '--pid', '--cap-add']) expect(fb).not.toContain(bad);
    expect(fb.join(' ')).not.toContain('docker.sock');
    expect(fb).toContain('--read-only');
    expect(fb).toContain('--cap-drop');
  });
  it('AG4-SBX-5 the fallback refuses a mount that would expose the admin socket or the docker socket', () => {
    for (const bad of ['/run/plumbline', '/run', '/', '/var/run/docker.sock', '/var/run/docker', 'relative/dir', '/run/x,y', '/run/../etc', '/run/x readonly', '/run/plumbline/.', '/run//plumbline', '/var//run/plumbline/']) {
      expect(() => assertSandboxSocketDir(bad), bad).toThrow();
    }
    expect(() => assertSandboxSocketDir('/run/plumbline-sbx')).not.toThrow();
  });
  it('limits can be lowered but never raised', () => {
    expect(clampLimits({ mem_mb: 99999, pids: 100000, wall_s: 9999 })).toEqual({ mem_mb: 256, cpus: 0.5, pids: 128, wall_s: 30 });
  });
  it('the sandbox package and image contain no credential-shaped names', () => {
    const dirs = ['../src/', '../image/', '../image/plumbline_sdk/'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((n) => /\.(ts|py|Dockerfile)$/.test(n) || n === 'Dockerfile')) {
        const text = readFileSync(dir + f, 'utf8');
        expect(text, f).not.toMatch(/VULTR_(API|KEY|INFERENCE|S3)/);
        expect(text, f).not.toMatch(/api\.vultr\.com|vultrinference|vultrobjects/);
      }
    }
  });
});

// The Docker layer of no_credential_in_sandbox lives in docker-layer.test.ts so every Docker test shares one network/relay setup.
