// DBG-O-M4: generated watchdog.env must boot the watchdog, and a re-run or rotation must keep the owner's hand-set values.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvText, runBootstrap, type BootstrapOptions } from '../ops/scripts/bootstrap-range.ts';
import { createFakeVultr, type FakeVultr } from './support/g1d-vultr-fake.ts';

const pubkey = Buffer.from((generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
const env = (): NodeJS.ProcessEnv => ({
  VULTR_API_KEY: 'OWNER-KEY-DO-NOT-PRINT', PLUMBLINE_POLICY_PUBKEY: pubkey, VULTR_INFERENCE_API_KEY: 'INFERENCE-KEY-DO-NOT-PRINT',
  VULTR_S3_HOST: 'ewr1.vultrobjects.com', VULTR_S3_ACCESS_KEY: 'S3ACCESS-DO-NOT-PRINT', VULTR_S3_SECRET_KEY: 'S3SECRET-DO-NOT-PRINT',
});

let out: string;
let fake: FakeVultr;
beforeEach(() => { out = mkdtempSync(`${tmpdir()}/dbg-m4-`); fake = createFakeVultr(); });
afterEach(() => { rmSync(out, { recursive: true, force: true }); });

const run = (over: Partial<BootstrapOptions> = {}) =>
  runBootstrap({ env: env(), out, sshKeyId: 'ssh-1', expiry: '2026-11-20T00:00:00Z', rotate: false, fetchImpl: fake.fetch, sleep: async () => {}, s3Client: fake.s3, ...over });
const wd = (): Record<string, string> => parseEnvText(readFileSync(`${out}/watchdog.env`, 'utf8'));
const handEdit = (file: string, extra: string): void => writeFileSync(`${out}/${file}`, readFileSync(`${out}/${file}`, 'utf8') + extra, { mode: 0o600 });

describe('DBG-O-M4 watchdog.env', () => {
  it('DBG-O-M4: --verifier-uid puts PLUMBLINE_VERIFIER_UID in watchdog.env; dry-run stays the first-creation default', async () => {
    const s = await run({ verifierUid: '997' });
    expect(wd()).toMatchObject({ PLUMBLINE_VERIFIER_UID: '997', PLUMBLINE_WATCHDOG_DRY_RUN: '1' });
    expect(s.pending_watchdog_env.some((p) => p.includes('PLUMBLINE_VERIFIER_UID'))).toBe(false);
    expect(s.pending_watchdog_env.some((p) => p.includes('DRY_RUN'))).toBe(true);
  });

  it('DBG-O-M4: without a verifier uid the file carries no placeholder and the summary says the uid is still pending', async () => {
    const s = await run();
    expect(wd().PLUMBLINE_VERIFIER_UID).toBeUndefined();
    expect(s.pending_watchdog_env[0]).toContain('PLUMBLINE_VERIFIER_UID');
  });

  it('DBG-O-M4: a re-run keeps hand-set DRY_RUN=0, VERIFIER_UID and the verifier.env WATCHDOG_UID', async () => {
    await run();
    handEdit('watchdog.env', 'PLUMBLINE_VERIFIER_UID=997\n');
    writeFileSync(`${out}/watchdog.env`, readFileSync(`${out}/watchdog.env`, 'utf8').replace('DRY_RUN=1', 'DRY_RUN=0'), { mode: 0o600 });
    handEdit('verifier.env', 'PLUMBLINE_WATCHDOG_UID=998\n');
    const s = await run();
    expect(wd()).toMatchObject({ PLUMBLINE_VERIFIER_UID: '997', PLUMBLINE_WATCHDOG_DRY_RUN: '0' });
    expect(parseEnvText(readFileSync(`${out}/verifier.env`, 'utf8')).PLUMBLINE_WATCHDOG_UID).toBe('998');
    expect(s.pending).toEqual([]);
    expect(s.pending_watchdog_env).toEqual([]);
  });

  it('DBG-O-M4: --rotate regenerates keys and tokens but still keeps the hand-set values', async () => {
    await run({ verifierUid: '997', watchdogUid: '998' });
    writeFileSync(`${out}/watchdog.env`, readFileSync(`${out}/watchdog.env`, 'utf8').replace('DRY_RUN=1', 'DRY_RUN=0'), { mode: 0o600 });
    const oldKey = wd().PLUMBLINE_WATCHDOG_KEY;
    await run({ rotate: true });
    expect(wd().PLUMBLINE_WATCHDOG_KEY).not.toBe(oldKey);
    expect(wd()).toMatchObject({ PLUMBLINE_VERIFIER_UID: '997', PLUMBLINE_WATCHDOG_DRY_RUN: '0' });
    expect(parseEnvText(readFileSync(`${out}/verifier.env`, 'utf8')).PLUMBLINE_WATCHDOG_UID).toBe('998');
  });

  it('DBG-O-M4: an explicit flag overrides the kept value', async () => {
    await run({ verifierUid: '997' });
    await run({ verifierUid: '1001' });
    expect(wd().PLUMBLINE_VERIFIER_UID).toBe('1001');
  });
});
