// Test fixtures: genuine ledger exports from the real ledger + real engine, and live-list builders.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ledger, exportLedger, openDb, recordDecision, type Db, type LedgerExport } from '@plumbline/ledger';
import { evaluate, parsePolicy, type CallRequest, type PolicyDoc } from '@plumbline/policy-engine';
import { replayState } from '../src/replay.ts';
import type { BaselineEntry, ReconcileInput } from '../src/reconcile.ts';
import type { LiveResource, Snapshot } from '../src/vultr-lite.ts';

const policy = (file: string, layer: 'session' | 'floor'): PolicyDoc => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../policy/${file}`, import.meta.url)), 'utf8'), layer);
  if (!r.ok) throw new Error(`bad policy ${file}`);
  return r.policy;
};
export const FLOOR = policy('floor.yaml', 'floor');
const SESSION = policy('session-default.yaml', 'session');
/** a floor that decides nothing: lets the test mint a GENUINE ALLOW for a request the real floor would refuse (a forged-in-spirit ledger row) */
const noopFloor = parsePolicy('version: 1\nrules:\n  - id: custom-noop\n    effect: deny\n    priority: 1\n    match: { verb: [delete], class: [instance], target_id: [never] }\n    reason: noop\n', 'floor');
if (!noopFloor.ok) throw new Error('noop floor');
const WEAK_FLOOR = noopFloor.policy;

export const T = 10_000_000;
export const OS = 'Debian 12 x64 (bookworm)';

export const prodBase: BaselineEntry = { id: 'i-prod', class: 'instance', label: 'plumbline-prod-db', plan: 'vc2-1c-1gb', region: 'ewr', power_status: 'running', os: OS };
export const regBase: BaselineEntry = { id: 'r-reg', class: 'registry', label: 'plumblinereg', plan: 'start_up', region: 'ewr' };
export const brokerBase: BaselineEntry = { id: 'i-broker', class: 'instance', label: 'plumbline-infra-broker', plan: 'vc2-1c-1gb', region: 'ewr', power_status: 'running', os: OS };
export const BASELINE: BaselineEntry[] = [prodBase, regBase, brokerBase];

export const live = (over: Partial<LiveResource> & { id: string }): LiveResource =>
  ({ class: 'instance', label: 'x', status: 'active', power_status: 'running', plan: 'vc2-1c-1gb', region: 'ewr', os: OS, ...over });
export const prodLive = live({ id: 'i-prod', label: 'plumbline-prod-db' });
export const regLive = live({ id: 'r-reg', class: 'registry', label: 'plumblinereg', plan: 'start_up', power_status: '', os: '' });
export const brokerLive = live({ id: 'i-broker', label: 'plumbline-infra-broker' });
export const INFRA: LiveResource[] = [prodLive, regLive, brokerLive];
export const snap = (resources: LiveResource[], at = T): Snapshot => ({ ok: true, at, live: resources });

type Params = CallRequest['params'];

export class Fixture {
  readonly db: Db = openDb(':memory:');
  clock = T - 600_000;
  readonly ledger = new Ledger(this.db, { session_ceiling_usd: 1.5, global_cap_usd: 10 }, () => this.clock);
  #n = 0;

  /** record a genuine ALLOW (floor `weak` = decides nothing) and the resource row that cites it */
  create(id: string, cls: 'instance' | 'vpc' | 'registry', params: Params, o: { weak?: boolean; session?: string } = {}): string {
    this.#n += 1;
    const req: CallRequest = { request_id: `r-${this.#n}`, task_id: 't', session_id: o.session ?? 's', verb: 'create', class: cls, target: {}, params, caller: 'sandbox' };
    const state = replayState(this.clock, params.plan ?? '');
    const d = evaluate(req, SESSION, o.weak ? WEAK_FLOOR : FLOOR, { ...state, session_ceiling_usd: 1.5, global_cap_usd: 10, rate_card: { fetched_at_ms: this.clock, hourly: { [params.plan ?? '']: 0.007 } } });
    if (d.decision !== 'ALLOW') throw new Error(`fixture expected ALLOW for ${id}, got ${d.decision} ${d.rule_id}`);
    const rec = recordDecision(this.db, d, { session_id: req.session_id, task_id: 't', model: null, call: null, vultr_ids: [id], request: req }, this.clock);
    this.ledger.recordResource({ id, class: cls, label: params.label ?? '', plan: params.plan ?? null, hourly: 0.007, ttl_h: 1, protected: false, session_id: req.session_id, allow_decision_id: rec.id });
    return rec.id;
  }

  /** record a genuine DENY (a 24c plan under the real floor) and return its decision id */
  denied(): string {
    this.#n += 1;
    const req: CallRequest = { request_id: `r-${this.#n}`, task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-24c-96gb', region: 'sgp', label: 'plumbline-wk-8', ttl_h: 1 }, caller: 'sandbox' };
    const d = evaluate(req, SESSION, FLOOR, replayState(this.clock, 'vc2-24c-96gb'));
    if (d.decision !== 'DENY') throw new Error('fixture expected DENY');
    return recordDecision(this.db, d, { session_id: 's', task_id: 't', model: null, call: null, vultr_ids: [], request: req }, this.clock).id;
  }

  worker(id: string, label = 'plumbline-wk-1'): string {
    return this.create(id, 'instance', { plan: 'vc2-1c-1gb', region: 'ewr', label, ttl_h: 1 });
  }

  /** the CO-2 H-1 bootstrap ALLOW row for the shared registry */
  registry(): string {
    return this.create('r-reg', 'registry', { label: 'plumblinereg', name: 'plumblinereg', region: 'ewr' }, { session: 'system' });
  }

  export(now = T + 3500): LedgerExport {
    return exportLedger(this.db, now);
  }
}

/** a complete, healthy input: both polls see the infra plus `extra`; the export is taken after the polls */
export function input(ledger: LedgerExport, extra: LiveResource[] = [], over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    poll1: snap([...INFRA, ...extra], T), poll2: snap([...INFRA, ...extra], T + 3000), ledger, baseline: BASELINE, watchdogDestroyed: [],
    floor: FLOOR, now: T + 3600, ledgerTrust: 'fetched', host: 'verifier-host', ...over,
  };
}

export function healthy(): Fixture {
  const f = new Fixture();
  f.registry();
  return f;
}
