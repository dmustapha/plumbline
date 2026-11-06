// File: apps/broker/test/support.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@plumbline/ledger';
import type { VersionListing } from '@plumbline/vultr-adapter';
import { createMockVultr } from '../../../packages/vultr-adapter/test/support/mock-vultr.ts';
import type { Config, Secrets } from '../src/config.ts';
import { assemble } from '../src/main.ts';
import { PolicyStore } from '../src/policyStore.ts';

const policyDir = fileURLToPath(new URL('../../../policy/', import.meta.url));

export const baseConfig: Config = {
  dataDir: '/tmp/plumbline-test', socketPath: '/tmp/plumbline-test/b.sock', sandboxBind: '127.0.0.1', sandboxPort: 0,
  sessionCeilingUsd: 1.5, globalCapUsd: 10, maxInstances: 4, bondEnabled: false, bondUsd: 0.05, bondBurnUsd: 0.045,
  floorPath: policyDir + 'floor.yaml', floorSigPath: policyDir + 'floor.yaml.sig', sessionDefaultPath: policyDir + 'session-default.yaml',
  requireFloorSig: false, verifierUrl: null, leaseTtlS: 45, bucket: 'plumbline-orders-db', rangeApiUrl: 'http://127.0.0.1:1', s3Host: 'example.invalid', sessionIdleMs: 1_800_000, playgroundRegions: ['ewr', 'ord'], playgroundCapPerRegion: 4,
};

export const secrets: Secrets = {
  apiToken: 'api-token-test', adminToken: 'admin-token-test', taskHmac: 'hmac-test-secret', leaseSecret: 'lease-test-secret', policyPubkeyB64: Buffer.alloc(32, 1).toString('base64'),
  vultr: { observer: 'obs', deployer: 'dep', network: 'net', registry: 'reg' }, inferenceKey: 'vsi-test', s3: { accessKey: 'a', secretKey: 'b' },
};

export function fakeS3(versions = 2, opts: { growOnPut?: boolean } = {}) {
  let live = Array.from({ length: versions }, (_, i) => ({ versionId: `v${i + 1}`, isLatest: i === versions - 1, size: 10, lastModified: new Date(2026, 10, 6, 0, i).toISOString() }));
  const markers: { versionId: string; isLatest: boolean; lastModified: string }[] = [];
  const ops: string[] = [];
  const keys: { op: string; key: string; session: string }[] = [];
  const fault = { listing: false };
  const listing = (): VersionListing => ({ versions: live, deleteMarkers: markers, fetched_at: new Date().toISOString() });
  return {
    ops, keys, fault,
    port: {
      listVersions: async (ctx: { session_id: string }, key: string) => {
        keys.push({ op: 'list', key, session: ctx.session_id });
        if (fault.listing) throw new Error('S3_DOWN');
        return listing();
      },
      putObject: async (_a: unknown, req: { target?: { id?: string } }) => {
        ops.push('put');
        keys.push({ op: 'put', key: req.target?.id ?? '', session: '' });
        if (opts.growOnPut) live = [...live, { versionId: `vg${live.length + 1}`, isLatest: true, size: 10, lastModified: new Date(2026, 10, 6, 1, live.length).toISOString() }];
        return 'vp';
      },
      deleteObject: async () => { ops.push('delete'); markers.push({ versionId: 'dm1', isLatest: true, lastModified: new Date().toISOString() }); return 'dm1'; },
      restoreVersion: async (_a: unknown, _c: unknown, _k: string, v: string) => { ops.push(`restore:${v}`); markers.length = 0; live = [...live, { versionId: 'v-restored', isLatest: true, size: 10, lastModified: new Date().toISOString() }]; return 'v-restored'; },
      getObject: async () => '{}',
    },
  };
}

export async function makeBroker(opts: { versions?: number; growOnPut?: boolean; viewKeys?: string[]; config?: Partial<Config>; clock?: () => number; floorTransform?: (t: string) => string } = {}) {
  const mock = createMockVultr({ viewKeys: opts.viewKeys });
  const s3 = fakeS3(opts.versions ?? 2, { growOnPut: opts.growOnPut });
  const dir = mkdtempSync(join(tmpdir(), 'plb-broker-'));
  const cfg = { ...baseConfig, dataDir: dir, ...opts.config };
  const policies = new PolicyStore(dir, (opts.floorTransform ?? ((t: string) => t))(readFileSync(cfg.floorPath, 'utf8')), undefined, secrets.policyPubkeyB64, false, readFileSync(cfg.sessionDefaultPath, 'utf8'), opts.clock);
  const app = await assemble(cfg, secrets, { fetchImpl: mock.fetch, s3: s3.port as never, db: openDb(':memory:'), policies, clock: opts.clock });
  await app.rate.refresh();
  mock.state.calls.length = 0;
  return { app, mock, s3 };
}
