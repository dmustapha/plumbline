import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import type { AllowDecision, CallRequest } from '@plumbline/policy-engine';
import { S3Store, type S3Sender } from '../src/index.ts';
import { allowFor, request } from './support/engine.ts';
import { sessionKeyGuard } from '@plumbline/rewind';

const ledger = () => new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 });
const SID = 'ab12cd34';
const OTHER = 'ef56ab90';
const KEY = `sessions/${SID}/orders.json`;

/** Versioned S3 in memory: same wire semantics the SDK commands carry (delete -> marker, copy by VersionId -> new version). */
function versionedS3(pageSize = 1000): S3Sender & { calls: { name: string; input: Record<string, unknown> }[]; keys(): string[] } {
  type V = { Key: string; VersionId: string; IsLatest: boolean; Size: number; LastModified: Date; body: string; marker: boolean };
  const store: V[] = [];
  let seq = 0;
  const add = (Key: string, body: string, marker: boolean): string => {
    store.filter((v) => v.Key === Key).forEach((v) => { v.IsLatest = false; });
    seq += 1;
    const VersionId = `ver${seq}`;
    store.unshift({ Key, VersionId, IsLatest: true, Size: body.length, LastModified: new Date(Date.UTC(2026, 10, 6, 0, 0, seq)), body, marker });
    return VersionId;
  };
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    keys: () => [...new Set(store.map((v) => v.Key))],
    async send(command: unknown) {
      const name = (command as object).constructor.name;
      const i = (command as { input: Record<string, any> }).input; // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ name, input: i });
      if (name === 'PutObjectCommand') return { VersionId: add(i.Key, String(i.Body), false) };
      if (name === 'DeleteObjectCommand') return { VersionId: add(i.Key, '', true), DeleteMarker: true };
      if (name === 'CopyObjectCommand') {
        const m = /^[^/]+\/(.+)\?versionId=(.+)$/.exec(String(i.CopySource));
        const src = store.find((v) => v.Key === decodeURIComponent(m?.[1] ?? '') && v.VersionId === decodeURIComponent(m?.[2] ?? '') && !v.marker);
        if (!src) throw Object.assign(new Error('no such version'), { name: 'NoSuchVersion' });
        return { VersionId: add(i.Key, src.body, false) };
      }
      if (name === 'GetObjectCommand') {
        const latest = store.find((v) => v.Key === i.Key && v.IsLatest);
        if (!latest || latest.marker) throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => latest.body } };
      }
      if (name === 'ListObjectVersionsCommand') {
        const rows = store.filter((v) => String(v.Key).startsWith(String(i.Prefix)));
        const start = i.VersionIdMarker ? rows.findIndex((v) => v.VersionId === i.VersionIdMarker) + 1 : 0;
        const slice = rows.slice(start, start + pageSize);
        const more = start + pageSize < rows.length;
        return {
          Versions: slice.filter((v) => !v.marker), DeleteMarkers: slice.filter((v) => v.marker), IsTruncated: more,
          NextKeyMarker: more ? slice.at(-1)?.Key : undefined, NextVersionIdMarker: more ? slice.at(-1)?.VersionId : undefined,
        };
      }
      return {};
    },
  };
}

const allow = (verb: CallRequest['verb'], key: string, session = SID, extra: Record<string, string> = {}): [AllowDecision, CallRequest] => {
  const req = request({ verb, class: 'bucket_object', session_id: session, target: { id: key, label: 'plumbline-orders-db', tags: [], resolved: true }, params: { key, ...extra } });
  return [allowFor(req, { object_versions: 3, restorable: true }), req];
};

describe('S3Store versioning path with an injected sender (U-5 code path, offline)', () => {
  const cfg = { host: 'ewr1.vultrobjects.example', accessKey: 'a', secretKey: 's', bucket: 'plumbline-orders-db' };
  it('delete -> delete marker -> restore by CopyObject VersionId -> new version, no latest marker', async () => {
    const s3 = versionedS3();
    const store = new S3Store(cfg, ledger(), s3);
    const ctx = { session_id: 's' };
    // Seed through the sender directly: two versions, as bootstrap leaves them.
    await s3.send(new (await import('@aws-sdk/client-s3')).PutObjectCommand({ Bucket: cfg.bucket, Key: 'orders.json', Body: 'one' }));
    await s3.send(new (await import('@aws-sdk/client-s3')).PutObjectCommand({ Bucket: cfg.bucket, Key: 'orders.json', Body: 'two' }));
    const before = await store.listVersions(ctx, 'orders.json');
    expect(before.versions).toHaveLength(2);
    expect(before.deleteMarkers).toHaveLength(0);
    const [dAllow, dReq] = allow('delete', 'orders.json', 's');
    await store.deleteObject(dAllow, dReq);
    const marked = await store.listVersions(ctx, 'orders.json');
    expect(marked.deleteMarkers[0]).toMatchObject({ isLatest: true });
    const newest = marked.versions[0]?.versionId ?? '';
    const [rAllow, rReq] = allow('restore', 'orders.json', 's', { version_id: newest });
    const created = await store.restoreVersion(rAllow, rReq);
    const after = await store.listVersions(ctx, 'orders.json');
    expect(after.deleteMarkers.some((m) => m.isLatest)).toBe(false);
    expect(after.versions).toHaveLength(3);
    expect(after.versions.find((v) => v.isLatest)?.versionId).toBe(created);
    await expect(store.getObject(ctx, 'orders.json')).resolves.toBe('two');
  });
  it('every request targets the path-style endpoint config and the bucket', async () => {
    const s3 = versionedS3();
    await new S3Store(cfg, ledger(), s3).listVersions({ session_id: 's' }, 'orders.json');
    expect(s3.calls[0]?.input).toMatchObject({ Bucket: 'plumbline-orders-db', Prefix: 'orders.json' });
  });
  it('a key with slashes keeps its slashes in CopySource and encodes everything else', async () => {
    const s3 = versionedS3();
    const store = new S3Store(cfg, ledger(), s3);
    const [pAllow, pReq] = allow('put', KEY);
    await store.putObject(pAllow, pReq, 'x');
    const [rAllow, rReq] = allow('restore', KEY, SID, { version_id: 'ver1' });
    await store.restoreVersion(rAllow, rReq);
    const copy = s3.calls.find((c) => c.name === 'CopyObjectCommand');
    expect(copy?.input.CopySource).toBe(`plumbline-orders-db/sessions/${SID}/orders.json?versionId=ver1`);
  });
  it('a listing that spans several pages is read completely', async () => {
    const s3 = versionedS3(2);
    const store = new S3Store(cfg, ledger(), s3);
    for (let n = 0; n < 5; n += 1) {
      const [a, r] = allow('put', 'orders.json', 's');
      await store.putObject(a, r, `b${n}`);
    }
    const l = await store.listVersions({ session_id: 's' }, 'orders.json');
    expect(l.versions).toHaveLength(5);
    expect(s3.calls.filter((c) => c.name === 'ListObjectVersionsCommand').length).toBeGreaterThan(1);
  });
  it('a listing that never finishes is an error, not a short count (object-state-unknown path)', async () => {
    const endless: S3Sender = { send: async () => ({ Versions: [], IsTruncated: true, NextKeyMarker: 'k', NextVersionIdMarker: 'v' }) };
    await expect(new S3Store(cfg, ledger(), endless).listVersions({ session_id: 's' }, 'orders.json')).rejects.toThrow('LISTING_INCOMPLETE');
  });
  it('an access error surfaces and marks the store unhealthy', async () => {
    const denied: S3Sender = { send: async () => { throw Object.assign(new Error('x'), { name: 'AccessDenied' }); } };
    const store = new S3Store(cfg, ledger(), denied);
    await expect(store.listVersions({ session_id: 's' }, 'orders.json')).rejects.toThrow();
    expect(store.healthy()).toBe(false);
  });
});

describe('AG4-PRD-6 the shared canary cannot be destroyed through another session', () => {
  const cfg = { host: 'h', accessKey: 'a', secretKey: 's', bucket: 'plumbline-orders-db', keyGuard: sessionKeyGuard };
  it('AG4-PRD-6 a session cannot delete, restore or put the shared orders.json', async () => {
    const s3 = versionedS3();
    const store = new S3Store(cfg, ledger(), s3);
    for (const verb of ['delete', 'put'] as const) {
      const [a, r] = allow(verb, 'orders.json');
      await expect(verb === 'delete' ? store.deleteObject(a, r) : store.putObject(a, r, 'x')).rejects.toThrow('SESSION_KEY_FORBIDDEN');
    }
    const [ra, rr] = allow('restore', 'orders.json', SID, { version_id: 'ver1' });
    await expect(store.restoreVersion(ra, rr)).rejects.toThrow('SESSION_KEY_FORBIDDEN');
    expect(s3.calls).toHaveLength(0);
  });
  it('AG4-PRD-6 a session cannot touch another session\'s canary, reads included', async () => {
    const s3 = versionedS3();
    const store = new S3Store(cfg, ledger(), s3);
    const [a, r] = allow('delete', `sessions/${OTHER}/orders.json`);
    await expect(store.deleteObject(a, r)).rejects.toThrow('SESSION_KEY_FORBIDDEN');
    await expect(store.listVersions({ session_id: SID }, `sessions/${OTHER}/orders.json`)).rejects.toThrow('SESSION_KEY_FORBIDDEN');
    await expect(store.getObject({ session_id: SID }, 'orders.json')).rejects.toThrow('SESSION_KEY_FORBIDDEN');
    expect(s3.calls).toHaveLength(0);
  });
  it('AG4-PRD-6 two sessions delete their own canaries and the shared orders.json is untouched', async () => {
    const s3 = versionedS3();
    const store = new S3Store(cfg, ledger(), s3);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({ Bucket: 'plumbline-orders-db', Key: 'orders.json', Body: 'shared-1' }));
    await s3.send(new PutObjectCommand({ Bucket: 'plumbline-orders-db', Key: 'orders.json', Body: 'shared-2' }));
    for (const sid of [SID, OTHER]) {
      const key = `sessions/${sid}/orders.json`;
      for (const body of ['a', 'b']) {
        const [pa, pr] = allow('put', key, sid);
        await store.putObject(pa, pr, body);
      }
      const [da, dr] = allow('delete', key, sid);
      await store.deleteObject(da, dr);
    }
    const shared = await store.listVersions({ session_id: 'system' }, 'orders.json');
    expect(shared.versions).toHaveLength(2);
    expect(shared.deleteMarkers).toHaveLength(0);
    expect(s3.keys().sort()).toEqual(['orders.json', `sessions/${OTHER}/orders.json`, `sessions/${SID}/orders.json`].sort());
  });
});
