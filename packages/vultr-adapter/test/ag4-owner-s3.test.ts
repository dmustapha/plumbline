import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, openDb, type SpendGate } from '@plumbline/ledger';
import { OwnerAdmin, S3Store, TierKeys, VultrHttp, mintOwnerAction, type OwnerActionRecord } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';

const ledger = () => new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 });
const cfg = { host: 'h', accessKey: 'a', secretKey: 's', bucket: 'b' };
const ctx = { session_id: 's' };

describe('AG4-ADP-3 owner mutators need a recorded, single-use OwnerAction', () => {
  const admin = () => new OwnerAdmin(new VultrHttp({ apiKey: 'o', gate: ledger(), fetchImpl: createMockVultr().fetch, sleep: async () => {} }));
  it('AG4-ADP-3 a plain object cannot call any owner mutator', async () => {
    const a = admin();
    const fake = { op: 'user.create', reason: 'r', id: 'oa-1', ts: 1 } as never;
    await expect(a.createServiceUser(fake, 'n', [])).rejects.toThrow('NOT_AN_OWNER_ACTION');
    await expect(a.issueKey(fake, 'u', 'n', 'x')).rejects.toThrow('NOT_AN_OWNER_ACTION');
    await expect(a.ipAllow(fake, 'u', '1.1.1.1')).rejects.toThrow('NOT_AN_OWNER_ACTION');
    await expect(a.deleteUser(fake, 'u')).rejects.toThrow('NOT_AN_OWNER_ACTION');
    await expect(a.deleteObjectStorage(fake, 's')).rejects.toThrow('NOT_AN_OWNER_ACTION');
    const s3 = new S3Store(cfg, ledger(), { send: async () => ({}) });
    await expect(s3.ensureVersionedBucket(fake, ctx)).rejects.toThrow('NOT_AN_OWNER_ACTION');
  });
  it('AG4-ADP-3 the token is recorded at mint, bound to its op, and single use', async () => {
    const rec: OwnerActionRecord[] = [];
    const t = mintOwnerAction('user.delete', 'teardown of tier user', (r) => rec.push(r));
    expect(rec).toHaveLength(1);
    expect(rec[0]?.op).toBe('user.delete');
    const a = admin();
    await expect(a.createServiceUser(t, 'n', [])).rejects.toThrow('OWNER_ACTION_MISMATCH');
    await a.deleteUser(t, 'u-1');
    await expect(a.deleteUser(t, 'u-1')).rejects.toThrow('OWNER_ACTION_REPLAY');
  });
  it('AG4-ADP-3 minting without a reason or a recorder is refused', () => {
    expect(() => mintOwnerAction('user.delete', '  ', () => {})).toThrow('OWNER_ACTION_REASON_REQUIRED');
    expect(() => mintOwnerAction('user.delete', 'why', undefined as never)).toThrow();
  });
  it('AG4-ADP-3 the bucket and subscription mutators run with a minted token', async () => {
    const sent: string[] = [];
    const s3 = new S3Store(cfg, ledger(), { send: async (c) => { sent.push((c as object).constructor.name); return {}; } });
    await s3.ensureVersionedBucket(mintOwnerAction('bucket.ensure', 'bootstrap', () => {}), ctx);
    expect(sent).toEqual(['CreateBucketCommand', 'PutBucketVersioningCommand']);
    const mock = createMockVultr();
    const a = new OwnerAdmin(new VultrHttp({ apiKey: 'o', gate: ledger(), fetchImpl: mock.fetch, sleep: async () => {} }));
    await a.deleteObjectStorage(mintOwnerAction('objstore.delete', 'teardown', () => {}), 'sub-1');
    expect(mock.state.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/object-storage/sub-1' });
  });
  it('AG4-ADP-3 mintOwnerAction is referenced nowhere outside ops/scripts and the adapter', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const walk = (d: string, out: string[] = []): string[] => {
      if (!existsSync(d)) return out;
      for (const n of readdirSync(d)) {
        const p = `${d}/${n}`;
        if (n === 'node_modules') continue;
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|mjs)$/.test(n)) out.push(p);
      }
      return out;
    };
    const offenders = [...walk(`${root}apps`), ...walk(`${root}packages`)]
      .filter((f) => !f.includes('/packages/vultr-adapter/'))
      .filter((f) => readFileSync(f, 'utf8').includes('mintOwnerAction'));
    expect(offenders).toEqual([]);
  });
});

describe('AG4-ADP-6 S3 receipts settle on success and failure', () => {
  const counting = () => {
    const settled: number[] = [];
    const gate: SpendGate = { charge: (kind, est) => ({ ok: true, receipt: { kind, estimate_usd: est, settle: (a) => { settled.push(a); } }, remaining_session: 9, remaining_global: 9 }) };
    return { gate, settled };
  };
  it('AG4-ADP-6 listVersions and getObject settle on success', async () => {
    const { gate, settled } = counting();
    const s3 = new S3Store(cfg, gate, { send: async () => ({ Versions: [], DeleteMarkers: [], Body: { transformToString: async () => 'x' } }) });
    await s3.listVersions(ctx, 'k');
    await expect(s3.getObject(ctx, 'k')).resolves.toBe('x');
    expect(settled).toHaveLength(2);
  });
  it('AG4-ADP-6 a failing call still settles', async () => {
    const { gate, settled } = counting();
    const s3 = new S3Store(cfg, gate, { send: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } });
    await expect(s3.getObject(ctx, 'k')).rejects.toThrow('denied');
    expect(settled).toHaveLength(1);
  });
  it('AG4-ADP-6 open reservations do not accumulate against the real ledger', async () => {
    const l = ledger();
    const s3 = new S3Store(cfg, l, { send: async () => ({ Versions: [] }) });
    for (let i = 0; i < 5; i += 1) await s3.listVersions(ctx, 'k');
    expect(l.sessionSpend('s')).toBe(0);
  });
});

describe('AG4-ADP-7 S3 health drives tier availability and fails closed', () => {
  it('AG4-ADP-7 no credentials -> unhealthy -> objstore false', () => {
    const s3 = new S3Store({ ...cfg, accessKey: '' }, ledger(), { send: async () => ({}) });
    expect(s3.healthy()).toBe(false);
    const tiers = new TierKeys({ observer: 'o', deployer: null, network: null, registry: null }, ledger());
    tiers.registerObjstore(s3);
    expect(tiers.availability().objstore).toBe(false);
  });
  it('AG4-ADP-7 an access failure marks objstore down, a missing key does not, a probe recovers', async () => {
    let mode: 'ok' | 'denied' | 'missing' = 'ok';
    const s3 = new S3Store(cfg, ledger(), {
      send: async () => {
        if (mode === 'denied') throw Object.assign(new Error('x'), { name: 'InvalidAccessKeyId' });
        if (mode === 'missing') throw Object.assign(new Error('x'), { name: 'NoSuchKey' });
        return {};
      },
    });
    const tiers = new TierKeys({ observer: 'o', deployer: null, network: null, registry: null }, ledger());
    tiers.registerObjstore(s3);
    expect(tiers.availability().objstore).toBe(true);
    mode = 'missing';
    await expect(s3.getObject(ctx, 'k')).rejects.toThrow();
    expect(tiers.availability().objstore).toBe(true);
    mode = 'denied';
    await expect(s3.getObject(ctx, 'k')).rejects.toThrow();
    expect(tiers.availability().objstore).toBe(false);
    mode = 'ok';
    expect(await s3.probe(ctx)).toBe(true);
    expect(tiers.availability().objstore).toBe(true);
  });
});
