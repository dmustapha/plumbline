// File: apps/broker/test/boot-guard.test.ts
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { policyMessage } from '@plumbline/policy-engine';
import { loadConfig } from '../src/config.ts';
import { PolicyStore } from '../src/policyStore.ts';
import { baseConfig } from './support.ts';

const env = {
  PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_ADMIN_TOKEN: 'b', PLUMBLINE_TASK_HMAC: 'c', PLUMBLINE_LEASE_SECRET: 'd', PLUMBLINE_POLICY_PUBKEY: 'e',
  VULTR_INFERENCE_API_KEY: 'f', VULTR_S3_HOST: 'ewr1.vultrobjects.com', VULTR_S3_ACCESS_KEY: 'g', VULTR_S3_SECRET_KEY: 'h',
};

describe('boot guards', () => {
  it('boots with the full variable set', () => {
    expect(loadConfig(env).config.globalCapUsd).toBe(10);
  });
  it('refuses the mock client', () => {
    expect(() => loadConfig({ ...env, PLUMBLINE_MOCK_VULTR: '1' })).toThrow('BOOT_REFUSED');
  });
  it('refuses the owner key on the broker VM', () => {
    expect(() => loadConfig({ ...env, VULTR_API_KEY: 'owner' })).toThrow('BOOT_REFUSED');
  });
  it('refuses a missing secret', () => {
    const { PLUMBLINE_API_TOKEN: _drop, ...rest } = env;
    expect(() => loadConfig(rest)).toThrow('missing PLUMBLINE_API_TOKEN');
  });
  it('refuses an unsigned or wrongly signed production floor', () => {
    const floor = readFileSync(baseConfig.floorPath, 'utf8');
    const def = readFileSync(baseConfig.sessionDefaultPath, 'utf8');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
    expect(() => new PolicyStore('/tmp/plumbline-test', floor, undefined, pub, true, def)).toThrow('SIG_REQUIRED');
    expect(() => new PolicyStore('/tmp/plumbline-test', floor, 'AAAA', pub, true, def)).toThrow('SIG_INVALID');
    const good = sign(null, Buffer.from(policyMessage(floor)), privateKey).toString('base64');
    expect(new PolicyStore('/tmp/plumbline-test', floor, good, pub, true, def).floor.layer).toBe('floor');
  });
});
