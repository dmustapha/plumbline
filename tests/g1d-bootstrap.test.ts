import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportLedger, openDb, verifyExport } from '@plumbline/ledger';
import { mintOwnerAction } from '@plumbline/vultr-adapter';
import { assertInputs, missingInputs, parseEnvText, renderEnv, runBootstrap, type BootstrapOptions } from '../ops/scripts/bootstrap-range.ts';
import { ownerContext } from '../ops/scripts/owner.ts';
import { createFakeVultr, type FakeVultr } from './support/g1d-vultr-fake.ts';

const pubkey = (() => {
  const x = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return Buffer.from(x, 'base64url').toString('base64');
})();
const baseEnv = (): NodeJS.ProcessEnv => ({
  VULTR_API_KEY: 'OWNER-KEY-DO-NOT-PRINT', PLUMBLINE_POLICY_PUBKEY: pubkey, VULTR_INFERENCE_API_KEY: 'INFERENCE-KEY-DO-NOT-PRINT',
  VULTR_S3_HOST: 'ewr1.vultrobjects.com', VULTR_S3_ACCESS_KEY: 'S3ACCESS-DO-NOT-PRINT', VULTR_S3_SECRET_KEY: 'S3SECRET-DO-NOT-PRINT',
});
const H = { verifier: 'v', broker: 'b' };
const sleep = async (): Promise<void> => {};

let out: string;
let fake: FakeVultr;
beforeEach(() => { out = mkdtempSync(`${tmpdir()}/g1d-`); fake = createFakeVultr(); });
afterEach(() => { rmSync(out, { recursive: true, force: true }); vi.restoreAllMocks(); });

const run = (over: Partial<BootstrapOptions> = {}) =>
  runBootstrap({ env: baseEnv(), out, sshKeyId: 'ssh-1', expiry: '2026-11-20T00:00:00Z', rotate: false, fetchImpl: fake.fetch, sleep, s3Client: fake.s3, ...over });
const read = (f: string): string => readFileSync(`${out}/${f}`, 'utf8');
const countRows = (t: string): number => { const db = openDb(`${out}/ledger.sqlite`); const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n; db.close(); return n; };
const mutations = (): string[] => fake.state.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(/\/[a-z]+-\d+/, '/:id')}`);
const allSecrets = (): string[] => ['OWNER-KEY-DO-NOT-PRINT', 'INFERENCE-KEY-DO-NOT-PRINT', 'S3ACCESS-DO-NOT-PRINT', 'S3SECRET-DO-NOT-PRINT', ...fake.state.users.flatMap((u) => u.keys),
  ...['broker.env', 'api.env', 'runner.env'].flatMap((f) => (existsSync(`${out}/${f}`) ? Object.entries(parseEnvText(read(f))).filter(([k]) => /TOKEN|HMAC|SECRET/.test(k)).map(([, v]) => v) : []))];

describe('G1d bootstrap-range against the mock Vultr', () => {
  it('creates two VMs, prod-db, plumblinereg, the bucket seed and six tier users, with 0600 env files', async () => {
    const s = await run();
    expect(fake.state.instances.map((i) => i.label).sort()).toEqual(['plumbline-infra-broker', 'plumbline-infra-verifier', 'plumbline-prod-db']);
    expect(fake.state.instances.find((i) => i.label === 'plumbline-infra-broker')).toMatchObject({ plan: 'vc2-2c-4gb', region: 'ewr' });
    expect(s.verifier_region).toBe('ord');
    expect(fake.state.registries.map((r) => r.name)).toEqual(['plumblinereg']);
    expect(fake.state.users).toHaveLength(6);
    for (const f of ['broker.env', 'api.env', 'runner.env', 'verifier.env', 'watchdog.env', 'baseline.json', 'ledger.sqlite']) expect((statSync(`${out}/${f}`).mode & 0o777).toString(8)).toBe('600');
  });

  it('INVARIANT 7: the ledger holds exactly one ALLOW row per real engine decision, hash-chained, every resource tied to one', async () => {
    const s = await run();
    expect(s.ledger).toMatchObject({ decisions: 6, resources: 4, gaps: [] }); // 3 instances + 1 registry created, 2 seed puts
    const db = openDb(`${out}/ledger.sqlite`);
    const exp = exportLedger(db, Date.now());
    db.close();
    expect(verifyExport(exp, { now_ms: Date.now(), max_age_ms: 60_000 })).toEqual({ ok: true });
    expect(exp.decisions.every((d) => d.decision === 'ALLOW' && d.session_id === 'system' && d.request_hash && d.request?.target.label)).toBe(true);
    expect(exp.counts.attacks).toBe(0); // owner rows never inflate the public attack counters
    expect(exp.resources.map((r) => r.label).sort()).toEqual(['plumbline-infra-broker', 'plumbline-infra-verifier', 'plumbline-prod-db', 'plumblinereg']);
    expect(exp.resources.find((r) => r.label === 'plumbline-prod-db')?.protected).toBe(true);
  });

  it('CO-2 H-1 / H-3: baseline holds plumblinereg and prod-db power_status and os', async () => {
    await run();
    const b = JSON.parse(read('baseline.json')) as { resources: Record<string, unknown>[] };
    expect(b.resources.find((r) => r.label === 'plumblinereg')).toMatchObject({ class: 'registry', region: 'ewr' });
    expect(b.resources.find((r) => r.label === 'plumbline-prod-db')).toMatchObject({ power_status: 'running', os: 'Debian 12 x64 (bookworm)', plan: 'vc2-1c-1gb', region: 'ewr' });
    expect(b.resources.map((r) => r.label)).toContain('plumbline-infra-verifier');
  });

  it('no key, token or secret value reaches stdout, stderr or the summary', async () => {
    const logs: string[] = [];
    const cap = (...a: unknown[]): void => { logs.push(a.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(cap);
    vi.spyOn(console, 'warn').mockImplementation(cap);
    vi.spyOn(console, 'error').mockImplementation(cap);
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { logs.push(String(c)); return true; });
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { logs.push(String(c)); return true; });
    const s = await run();
    w.mockRestore(); e.mockRestore();
    const everything = logs.join('\n') + JSON.stringify(s) + read('bootstrap-summary.json');
    for (const secret of allSecrets()) expect(everything, secret.slice(0, 12)).not.toContain(secret);
    expect(allSecrets().length).toBeGreaterThan(10);
  });

  it('U-10: no warning leans on date_expire; the summary says expiry is unverified', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await run();
    expect(warn).not.toHaveBeenCalled();
    expect(s.key_expiry).toContain('UNVERIFIED (U-10)');
    expect(parseEnvText(read('api.env')).PLUMBLINE_KEY_EXPIRY_ISO).toBe('2026-11-20T00:00:00Z');
  });

  it('AG4-OPS-1: every account mutation is matched by a recorded OwnerAction, every resource mutation by a recorded ALLOW', async () => {
    await run();
    const db = openDb(`${out}/ledger.sqlite`);
    const ops = (db.prepare("SELECT detail_json FROM events WHERE kind='owner_action'").all() as { detail_json: string }[]).map((r) => (JSON.parse(r.detail_json) as { op: string }).op);
    db.close();
    const n = (op: string): number => ops.filter((x) => x === op).length;
    const m = mutations();
    expect(n('user.create')).toBe(m.filter((x) => x === 'POST /users').length);
    expect(n('user.issue_key')).toBe(m.filter((x) => x.endsWith('/apikeys')).length);
    expect(n('user.ip_allow')).toBe(m.filter((x) => x.endsWith('/ip-whitelist')).length);
    expect(n('bucket.ensure')).toBe(1);
    expect(m.filter((x) => x === 'POST /instances' || x === 'POST /registry').length).toBe(countRows('resources'));
  });

  it('AG4-OPS-1: the scripts contain no raw mutating request and no object-storage DELETE', () => {
    for (const f of ['owner.ts', 'bootstrap-range.ts']) {
      const text = readFileSync(fileURLToPath(new URL(`../ops/scripts/${f}`, import.meta.url)), 'utf8');
      expect(text, f).not.toMatch(/request(<[^>]*>)?\(\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(text, f).not.toContain('/object-storage');
    }
  });

  it('AG4-OPS-1: a plain call, a wrong-op token and a replayed token are all refused by the adapter', async () => {
    const o = ownerContext({ env: baseEnv(), fetchImpl: fake.fetch, sleep });
    await expect(o.admin.deleteUser({ op: 'user.delete', reason: 'x', id: 'oa-1', ts: 1 } as never, 'u')).rejects.toThrow('NOT_AN_OWNER_ACTION');
    const t = o.action('user.create', 'one');
    await expect(o.admin.deleteUser(t, 'u')).rejects.toThrow('OWNER_ACTION_MISMATCH');
    expect(() => mintOwnerAction('user.delete', '', () => {})).toThrow('OWNER_ACTION_REASON_REQUIRED');
    o.close();
  });

  it('AG4-OPS-1: the owner policy refuses a non-plumbline label and the refusal is itself recorded', () => {
    const o = ownerContext({ env: baseEnv(), fetchImpl: fake.fetch, sleep, ledgerPath: `${out}/x.sqlite` });
    expect(() => o.grant('create', 'instance', 'someone-elses-vm', { params: { plan: 'vc2-1c-1gb', region: 'ewr' } })).toThrow('owner call refused');
    const row = o.db.prepare('SELECT decision, rule_id FROM decisions').get() as { decision: string; rule_id: string };
    expect(row.decision).toBe('DENY');
    o.close();
  });
});

describe('AG4-OPS-7 idempotent for real', () => {
  it('AG4-OPS-7 a second run creates nothing, issues no key, writes no decision row and keeps every env file byte-identical', async () => {
    await run();
    const before = Object.fromEntries(['broker.env', 'api.env', 'runner.env', 'verifier.env', 'watchdog.env'].map((f) => [f, read(f)]));
    const rows = countRows('decisions');
    const issued = fake.state.issued;
    fake.state.calls.length = 0;
    const s = await run();
    expect(fake.state.issued).toBe(issued);
    expect(mutations()).toEqual([]);
    expect(countRows('decisions')).toBe(rows);
    expect(s.tokens).toBe('reused');
    expect(Object.values(s.users).every((u) => u.how === 'reused')).toBe(true);
    for (const [f, text] of Object.entries(before)) expect(read(f), f).toBe(text);
  });

  it('AG4-OPS-7 --rotate recreates every user (revoking old keys, U-11) and regenerates tokens', async () => {
    await run();
    const oldKeys = fake.state.users.flatMap((u) => u.keys);
    const oldBroker = read('broker.env');
    const s = await run({ rotate: true });
    expect(fake.state.users).toHaveLength(6);
    const live = fake.state.users.flatMap((u) => u.keys);
    expect(live).toHaveLength(6);
    expect(live.some((k) => oldKeys.includes(k))).toBe(false);
    expect(Object.values(s.users).every((u) => u.how === 'recreated')).toBe(true);
    expect(s.tokens).toBe('generated');
    expect(parseEnvText(read('broker.env')).PLUMBLINE_API_TOKEN).not.toBe(parseEnvText(oldBroker).PLUMBLINE_API_TOKEN);
  });

  it('AG4-OPS-7 a lost key file recreates only that user, and a stray whitelisted IP forces recreation', async () => {
    await run();
    rmSync(`${out}/watchdog.env`);
    fake.state.users.find((u) => u.name === 'plumbline-network')?.ips.push('198.51.100.9');
    const s = await run();
    expect(s.users['plumbline-watchdog']?.how).toBe('recreated');
    expect(s.users['plumbline-network']?.how).toBe('recreated');
    expect(Object.entries(s.users).filter(([, u]) => u.how === 'reused')).toHaveLength(4);
    expect(fake.state.users.flatMap((u) => u.keys)).toHaveLength(6);
  });

  it('AG4-OPS-7 an existing user with the wrong ACLs is recreated, not trusted', async () => {
    await run();
    const u = fake.state.users.find((x) => x.name === 'plumbline-observer');
    u?.acls.push('manage_users');
    const s = await run();
    expect(s.users['plumbline-observer']?.how).toBe('recreated');
    expect(fake.state.users.find((x) => x.name === 'plumbline-observer')?.acls).toEqual(['subscriptions_view']);
  });

  it('AG4-OPS-7 a ledger that lost a live resource is reported as a gap, not papered over with a made-up row', async () => {
    await run();
    rmSync(`${out}/ledger.sqlite`);
    for (const x of ['-wal', '-shm']) rmSync(`${out}/ledger.sqlite${x}`, { force: true });
    const s = await run();
    expect(s.ledger.gaps).toHaveLength(4);
    expect(s.ledger.resources).toBe(0);
  });
});

describe('AG4-OPS-8 missing inputs fail the run', () => {
  for (const name of ['PLUMBLINE_POLICY_PUBKEY', 'VULTR_INFERENCE_API_KEY', 'VULTR_S3_SECRET_KEY', 'VULTR_S3_ACCESS_KEY', 'VULTR_S3_HOST', 'VULTR_API_KEY']) {
    it(`AG4-OPS-8 without ${name} nothing is called and nothing is written`, async () => {
      const env = baseEnv();
      delete env[name];
      await expect(run({ env })).rejects.toThrow(`BOOTSTRAP_INPUT_MISSING: ${name}`);
      expect(fake.state.calls).toHaveLength(0);
      expect(existsSync(`${out}/broker.env`)).toBe(false);
    });
  }
  it('AG4-OPS-8 an empty or "undefined" value counts as missing; a malformed public key and a missing ssh key are refused', () => {
    expect(missingInputs({ ...baseEnv(), PLUMBLINE_POLICY_PUBKEY: '' }, 'k')).toEqual(['PLUMBLINE_POLICY_PUBKEY']);
    expect(missingInputs({ ...baseEnv(), VULTR_INFERENCE_API_KEY: 'undefined' }, 'k')).toEqual(['VULTR_INFERENCE_API_KEY']);
    expect(() => assertInputs({ ...baseEnv(), PLUMBLINE_POLICY_PUBKEY: 'AAAA' }, 'k', '2026-11-20T00:00:00Z')).toThrow('BOOTSTRAP_INPUT_INVALID');
    expect(() => assertInputs(baseEnv(), undefined, '2026-11-20T00:00:00Z')).toThrow('VULTR_SSH_KEY_ID');
    expect(() => assertInputs(baseEnv(), 'k', 'not-a-date')).toThrow('--expiry');
  });
  it('AG4-OPS-8 renderEnv refuses a leftover placeholder, an empty value and "undefined"', () => {
    expect(() => renderEnv('A=__SET_BY_BOOTSTRAP__\n', {}, H)).toThrow('BOOTSTRAP_PLACEHOLDER_LEFT: A');
    expect(() => renderEnv('A=1\n', { A: '' }, H)).toThrow('BOOTSTRAP_VALUE_MISSING: A');
    expect(() => renderEnv('A=1\n', { A: 'undefined' }, H)).toThrow('BOOTSTRAP_VALUE_MISSING: A');
    expect(renderEnv('PLUMBLINE_SANDBOX_RUNTIME=\nB=x__VERIFIER_HOST__\nC=y__BROKER_HOST__\nD=__SET_BY_BOOTSTRAP__\n', {}, H, ['D'])).toBe('PLUMBLINE_SANDBOX_RUNTIME=\nB=xv\nC=yb\n');
  });
  it('AG4-OPS-8 the generated broker.env carries the policy key and every setting of the example, with no placeholder', async () => {
    await run();
    const broker = parseEnvText(read('broker.env'));
    const example = parseEnvText(readFileSync(fileURLToPath(new URL('../ops/env/broker.env.example', import.meta.url)), 'utf8'));
    for (const k of Object.keys(example)) expect(broker[k], k).toBeDefined();
    expect(broker).toMatchObject({ PLUMBLINE_POLICY_PUBKEY: pubkey, PLUMBLINE_REQUIRE_FLOOR_SIG: '1', PLUMBLINE_SESSION_CEILING_USD: '1.5', PLUMBLINE_GLOBAL_CAP_USD: '10', PLUMBLINE_MAX_INSTANCES: '4', PLUMBLINE_SOCKET: '/run/plumbline/broker.sock', PLUMBLINE_SANDBOX_BIND: '172.17.0.1' });
    for (const f of ['broker.env', 'api.env', 'runner.env', 'verifier.env', 'watchdog.env']) {
      expect(read(f), f).not.toMatch(/undefined|__[A-Z_]+__/);
      for (const [k, v] of Object.entries(parseEnvText(read(f)))) if (!['PLUMBLINE_SANDBOX_RUNTIME', 'PLUMBLINE_SANDBOX_SOCKET_DIR'].includes(k)) expect(v, `${f} ${k}`).not.toBe('');
    }
    expect(parseEnvText(read('watchdog.env')).PLUMBLINE_POLICY_PUBKEY).toBe(pubkey);
    expect(broker.PLUMBLINE_VERIFIER_URL).toMatch(/^https:\/\/203-0-113-\d+\.sslip\.io$/);
  });
});

describe('verifier.env follows the verifier example', () => {
  it('AG4-OPS-8 carries the example settings, the policy key and the broker host; the watchdog uid is reported pending until VM 2 exists', async () => {
    const s = await run();
    const v = parseEnvText(read('verifier.env'));
    expect(v).toMatchObject({ PLUMBLINE_POLL_GAP_MS: '3000', PLUMBLINE_FLOOR_PATH: '/opt/plumbline/app/policy/floor.yaml', PLUMBLINE_POLICY_PUBKEY: pubkey, PLUMBLINE_BASELINE_PATH: '/etc/plumbline/baseline.json' });
    expect(v.PLUMBLINE_BROKER_PUBLIC_URL).toMatch(/^https:\/\/203-0-113-\d+\.sslip\.io$/);
    expect(v.PLUMBLINE_WATCHDOG_UID).toBeUndefined();
    expect(s.pending[0]).toContain('PLUMBLINE_WATCHDOG_UID');
  });
  it('--watchdog-uid fills the line and clears the pending note', async () => {
    const s = await run({ watchdogUid: '998' });
    expect(parseEnvText(read('verifier.env')).PLUMBLINE_WATCHDOG_UID).toBe('998');
    expect(s.pending).toEqual([]);
  });
});

describe('G1d guards', () => {
  it('an instance whose live plan drifted from the expected one stops the run', async () => {
    await run();
    const inst = fake.state.instances.find((i) => i.label === 'plumbline-prod-db');
    if (inst) inst.plan = 'vc2-4c-8gb';
    await expect(run()).rejects.toThrow('INSTANCE_DRIFT');
  });
  it('an instance that never becomes active fails the run', async () => {
    fake.state.activeAfterPolls = 10_000;
    await expect(run({ pollTries: 3 })).rejects.toThrow('did not become active');
  });
  it('a bucket that already has versions is not reseeded', async () => {
    await run();
    const puts = fake.state.s3.filter((n) => n === 'PutObjectCommand').length;
    await run();
    expect(fake.state.s3.filter((n) => n === 'PutObjectCommand').length).toBe(puts);
  });
  it('writeAtomic leaves 0600 even over a loose file', async () => {
    writeFileSync(`${out}/broker.env`, 'x=1\n');
    chmodSync(`${out}/broker.env`, 0o644);
    await run();
    expect((statSync(`${out}/broker.env`).mode & 0o777).toString(8)).toBe('600');
  });
});
