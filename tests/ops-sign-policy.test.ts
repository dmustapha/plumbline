import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPolicySignature } from '@plumbline/policy-engine';
import { initKey, keyPathFromEnv, signFloor } from '../ops/scripts/sign-policy.ts';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'plb-sign-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('sign-policy', () => {
  it('signs a floor with a detached Ed25519 signature that the engine verifies, and the key is 0600', () => {
    const d = tmp(); const key = join(d, 'k', 'policy.pem'); const floor = join(d, 'floor.yaml');
    writeFileSync(floor, 'version: 2\nrules: []\n');
    const pub = initKey(key);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(signFloor(key, floor)).toBe(pub);
    const sig = readFileSync(`${floor}.sig`, 'utf8').trim();
    expect(verifyPolicySignature('version: 2\nrules: []\n', sig, pub)).toBe('OK');
    expect(verifyPolicySignature('version: 2\nrules: [x]\n', sig, pub)).toBe('SIG_INVALID');
  });
  it('init returns only the public key and never the private material', () => {
    const d = tmp(); const key = join(d, 'p.pem');
    const out = initKey(key);
    const pem = readFileSync(key, 'utf8');
    expect(out).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(out).not.toContain('PRIVATE');
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(pem.replace(/\s/g, '')).not.toContain(out);
  });
  it('refuses to overwrite an existing key and to sign without one', () => {
    const d = tmp(); const key = join(d, 'p.pem'); const floor = join(d, 'f.yaml');
    writeFileSync(floor, 'x');
    expect(() => signFloor(key, floor)).toThrow('run with --init');
    initKey(key);
    expect(() => initKey(key)).toThrow('refusing to overwrite');
    expect(existsSync(`${floor}.sig`)).toBe(false);
  });
  it('the key path comes from PLUMBLINE_SIGNING_KEY and must be outside the repository', () => {
    expect(() => keyPathFromEnv({}, '/repo')).toThrow('not set');
    expect(() => keyPathFromEnv({ PLUMBLINE_SIGNING_KEY: '/repo/policy/key.pem' }, '/repo')).toThrow('inside the repository');
    expect(keyPathFromEnv({ PLUMBLINE_SIGNING_KEY: '/home/me/.plumbline/key.pem' }, '/repo')).toBe('/home/me/.plumbline/key.pem');
  });
});
