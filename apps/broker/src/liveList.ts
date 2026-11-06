// File: apps/broker/src/liveList.ts
import { Firewalls, Instances, Registries, Vpcs, type S3Store, type TierKeys } from '@plumbline/vultr-adapter';

type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 160) };
  }
}

export class LiveList {
  constructor(
    private readonly tiers: TierKeys,
    private readonly s3: Pick<S3Store, 'listVersions'>,
    private readonly clock: () => number = Date.now,
  ) {}

  async fetch(sessionId: string) {
    const ctx = { session_id: sessionId };
    const [instances, firewalls, vpcs, registries, bucket] = await Promise.all([
      section(() => new Instances(this.tiers.http('observer')).list(ctx)),
      section(() => new Firewalls(this.tiers.http('network')).list(ctx)),
      section(() => new Vpcs(this.tiers.http('observer')).list(ctx)),
      section(() => new Registries(this.tiers.http('observer')).list(ctx)),
      section(() => this.s3.listVersions(ctx, 'orders.json')),
    ]);
    const at = this.clock();
    return { fetched_at_ms: at, fetched_at: new Date(at).toISOString(), instances, firewalls, vpcs, registries, bucket, tiers: this.tiers.availability() };
  }
}
