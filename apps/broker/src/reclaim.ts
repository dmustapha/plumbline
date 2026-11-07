// File: apps/broker/src/reclaim.ts
// M3 + M4: reconcile the ledger's worker rows and unknown-outcome records against the live Vultr instance list.
import { LIVE_WORKER_WHERE, listUnknownOutcomes, recordEvent, resolveUnknownOutcome, type Db, type Ledger } from '@plumbline/ledger';
import { Instances, type InstanceView, type TierKeys } from '@plumbline/vultr-adapter';
import type { Outcome } from './pipeline.ts';

export interface ReclaimDeps {
  db: Db;
  ledger: Ledger;
  tiers: TierKeys;
  clock: () => number;
  cleanup: (ownerSid: string, cls: 'instance', id: string) => Promise<Outcome>;
}

const WORKER_PREFIX = 'plumbline-wk-';
const openCreates = (db: Db) => listUnknownOutcomes(db).filter((u) => u.outcome.method === 'POST' && u.outcome.path === '/instances');
const deleted = (o: Outcome): boolean => o.status === 'DECIDED' && !o.error && o.decision.decision === 'ALLOW';

/**
 * Lists instances once (fail closed: a listing error changes nothing), then
 * M3: closes every live worker row whose instance Vultr no longer has, and
 * M4: resolves unknown create outcomes, deleting an unrecorded plumbline-wk-* instance only after two consecutive sightings
 * (so a create still being recorded is never raced), or closing the outcome after two sweeps that found nothing.
 */
export function makeInstanceReconciler(d: ReclaimDeps): () => Promise<void> {
  let seenUnrecorded = new Set<string>();
  let emptySweeps = 0;

  const closeGoneRows = (live: Set<string>): void => {
    const rows = d.db.prepare(`SELECT id, session_id FROM resources WHERE ${LIVE_WORKER_WHERE}`).all() as { id: string; session_id: string }[];
    for (const r of rows.filter((x) => !live.has(x.id))) {
      d.ledger.markDestroyed(r.id);
      recordEvent(d.db, 'INSTANCE_GONE', r.session_id, { id: r.id }, d.clock());
    }
  };

  const resolveOne = (note: string): void => {
    const first = openCreates(d.db)[0];
    if (first) resolveUnknownOutcome(d.db, first.outcome.request_id, note, d.clock());
  };

  const reclaimUnknown = async (list: InstanceView[]): Promise<void> => {
    if (openCreates(d.db).length === 0) { seenUnrecorded = new Set(); emptySweeps = 0; return; }
    const known = new Set((d.db.prepare("SELECT id FROM resources WHERE class='instance'").all() as { id: string }[]).map((r) => r.id));
    const orphans = list.filter((i) => !known.has(i.id) && i.label.startsWith(WORKER_PREFIX));
    for (const o of orphans.filter((i) => seenUnrecorded.has(i.id))) {
      if (deleted(await d.cleanup('system', 'instance', o.id))) resolveOne(`reclaimed unrecorded instance ${o.id}`);
    }
    seenUnrecorded = new Set(orphans.map((i) => i.id));
    emptySweeps = orphans.length === 0 ? emptySweeps + 1 : 0;
    if (emptySweeps >= 2) { resolveOne('no instance found in two sweeps'); emptySweeps = 0; }
  };

  return async () => {
    let list: InstanceView[];
    try {
      list = await new Instances(d.tiers.http('observer')).list({ session_id: 'system' });
    } catch (e) {
      console.error(JSON.stringify({ evt: 'instance-reconcile-error', msg: String((e as Error).message) }));
      return;
    }
    closeGoneRows(new Set(list.map((i) => i.id)));
    await reclaimUnknown(list);
  };
}
