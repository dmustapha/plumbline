// File: apps/verifier/src/replay.ts
// CO-2 E-1: re-run the pure policy engine on LIVE state. The ledger row says what the broker's engine decided; this asks the question
// again with what Vultr reports now (plan, region, label), under the production floor and a permissive session layer, so a forged or
// stale ALLOW cannot hide a vc2-24c-96gb in sgp. The verifier only calls the pure `evaluate` (no I/O, no credential).
// Not replayed: dollar rules (the export carries no session spend or ceiling), kill switch, tiers, worker count: they are session state.
import { evaluate, parsePolicy, type CallRequest, type EngineState, type PolicyDoc } from '@plumbline/policy-engine';
import type { ExportResource } from '@plumbline/ledger';
import type { LiveResource } from './vultr-lite.ts';

const SESSION_REPLAY_POLICY = `version: 1
rules:
  - id: custom-verifier-replay-allow-create
    effect: allow
    priority: 10
    match: { verb: [create], class: [instance, vpc, registry, firewall_group] }
    reason: "replay: only the floor decides"
`;

export function replaySessionPolicy(): PolicyDoc {
  const r = parsePolicy(SESSION_REPLAY_POLICY, 'session');
  if (!r.ok) throw new Error('verifier replay policy is invalid');
  return r.policy;
}

const BIG = Number.MAX_SAFE_INTEGER;

/** A state in which no session or budget rule can fire: only plan, region, label, scope and prod-immutability rules decide. */
export function replayState(now: number, plan: string): EngineState {
  return {
    now_ms: now, rate_card: { fetched_at_ms: now, hourly: { [plan]: 0 } }, session_spent_usd: 0, session_ceiling_usd: BIG,
    global_spent_usd: 0, global_cap_usd: BIG, live_worker_count: 0, max_instances: BIG, kill_switch: false, session_tier: 'standard',
    tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
    object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
  };
}

export interface Violation {
  detail: string;
}

function driftOf(live: LiveResource, row: ExportResource): string | null {
  const diffs: string[] = [];
  if (row.label !== live.label) diffs.push(`label ${row.label} -> ${live.label}`);
  if (live.class === 'instance' && row.plan !== null && row.plan !== live.plan) diffs.push(`plan ${row.plan} -> ${live.plan}`);
  if (row.region !== null && row.region !== live.region) diffs.push(`region ${row.region} -> ${live.region}`);
  return diffs.length > 0 ? `live differs from what the ALLOW decided: ${diffs.join(', ')}` : null;
}

function liveRequest(live: LiveResource, row: ExportResource): CallRequest {
  const src = row.request;
  const params = { ...(src?.params ?? {}), label: live.label, region: live.region, ...(live.class === 'instance' ? { plan: live.plan } : {}) };
  return {
    request_id: `verifier-${live.id}`, task_id: 'verifier', session_id: 'verifier', verb: 'create', class: live.class,
    target: { ...(src?.target ?? {}) }, params, caller: 'sandbox',
  };
}

/** null when the live resource is a legitimate ALLOW under the floor; otherwise what is wrong with it */
export function replayLive(floor: PolicyDoc, live: LiveResource, row: ExportResource, now: number): Violation | null {
  const drift = driftOf(live, row);
  if (drift) return { detail: drift };
  const d = evaluate(liveRequest(live, row), replaySessionPolicy(), floor, replayState(now, live.plan));
  if (d.decision === 'ALLOW') return null;
  return { detail: `the policy engine re-run on live state says ${d.decision} (${d.rule_id}): ${d.reason}` };
}
