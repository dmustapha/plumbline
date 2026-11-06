// File: apps/broker/src/playground.ts
import type { Db } from '@plumbline/ledger';

/** Live protected playground VPCs per region, read from the ledger (the region is the one the ALLOW decision recorded). */
export function playgroundCounts(db: Db): Map<string, number> {
  const rows = db.prepare(
    `SELECT d.region AS region, COUNT(*) AS n FROM resources r JOIN decisions d ON d.id = r.allow_decision_id
     WHERE r.class = 'vpc' AND r.protected = 1 AND r.destroyed_at_ms IS NULL GROUP BY d.region`,
  ).all() as { region: string | null; n: number }[];
  return new Map(rows.map((r) => [r.region ?? '', r.n]));
}

/** The first region, in order, that still has room; null when every region is at its cap. */
export function pickPlaygroundRegion(db: Db, regions: string[], capPerRegion: number): string | null {
  const counts = playgroundCounts(db);
  return regions.find((r) => (counts.get(r) ?? 0) < capPerRegion) ?? null;
}

/** Runs tasks one at a time, so two simultaneous sessions cannot both count the last free slot. */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export function capacityError(regions: string[], cap: number): { code: 'PLAYGROUND_CAPACITY'; detail: string } {
  return { code: 'PLAYGROUND_CAPACITY', detail: `every playground region (${regions.join(', ')}) already holds ${cap} live playgrounds; no VPC was requested` };
}
