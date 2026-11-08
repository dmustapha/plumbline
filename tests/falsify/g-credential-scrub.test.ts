// FALSIFY (g): a credential-looking value planted in the broker env never reaches the sandbox.
// The Docker-layer no_credential_in_sandbox test needs a live Docker daemon (skipped without it), so this asserts the host-side
// scrubbing that decides what a sandbox can ever inherit: cleanEnv() for the docker CLI, buildRunArgs() for the container.
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunArgs, clampLimits, cleanEnv } from '../../packages/sandbox/src/index.ts';

const PLANTED: Record<string, string> = {
  VULTR_API_KEY: 'PLANTED-vultr-api-key-aaaa1111',
  VULTR_KEY_DEPLOYER: 'PLANTED-deployer-key-bbbb2222',
  VULTR_INFERENCE_KEY: 'PLANTED-inference-key-cccc3333',
  VULTR_S3_SECRET: 'PLANTED-s3-secret-dddd4444',
  PLUMBLINE_API_TOKEN: 'PLANTED-api-token-eeee5555',
  AWS_SECRET_ACCESS_KEY: 'PLANTED-aws-ffff6666',
  OPENAI_API_KEY: 'sk-PLANTED-gggg7777',
};
const saved: Record<string, string | undefined> = {};
for (const k of Object.keys(PLANTED)) saved[k] = process.env[k];
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe('FALSIFY (g) credential planted in the broker env', () => {
  it('control: the planted values really are in process.env', () => {
    Object.assign(process.env, PLANTED);
    for (const [k, v] of Object.entries(PLANTED)) expect(process.env[k]).toBe(v);
  });
  it('cleanEnv() drops every planted name and no value survives anywhere in the result', () => {
    Object.assign(process.env, PLANTED);
    const env = cleanEnv();
    const flat = JSON.stringify(env);
    for (const [k, v] of Object.entries(PLANTED)) {
      expect(env[k], k).toBeUndefined();
      expect(flat, k).not.toContain(v);
    }
    expect(env.PATH).toBeTruthy();
  });
  it('cleanEnv() passes only an allow-list of names (PATH, DOCKER_HOST, DOCKER_CONFIG)', () => {
    Object.assign(process.env, PLANTED);
    expect(Object.keys(cleanEnv()).every((k) => ['PATH', 'DOCKER_HOST', 'DOCKER_CONFIG'].includes(k))).toBe(true);
  });
  it('the container run args carry no env flag and none of the planted values, in either transport', () => {
    Object.assign(process.env, PLANTED);
    const relay = buildRunArgs({ name: 'plb-sbx-x', limits: clampLimits() });
    const sock = buildRunArgs({ name: 'plb-sbx-x', limits: clampLimits(), transport: { kind: 'socket', socketDir: '/run/plumbline-sbx' } });
    for (const args of [relay, sock]) {
      for (const bad of ['-e', '--env', '--env-file']) expect(args).not.toContain(bad);
      const flat = args.join(' ');
      for (const v of Object.values(PLANTED)) expect(flat).not.toContain(v);
    }
  });
});
