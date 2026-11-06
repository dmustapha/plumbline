import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, parsePolicy, type AllowDecision, type CallRequest, type EngineState } from '@plumbline/policy-engine';

const load = (f: string, l: 'session' | 'floor') => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../../policy/${f}`, import.meta.url)), 'utf8'), l);
  if (!r.ok) throw new Error('bad policy');
  return r.policy;
};

export const STATE: EngineState = {
  now_ms: 1000, rate_card: { fetched_at_ms: 1000, hourly: { 'vc2-1c-1gb': 0.007, 'vc2-2c-4gb': 0.027 } }, session_spent_usd: 0, session_ceiling_usd: 1.5,
  global_spent_usd: 0, global_cap_usd: 10, live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
  tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
};

let seq = 0;
export const request = (r: Partial<CallRequest>): CallRequest => {
  seq += 1;
  return { request_id: `req-${seq}-${Math.random().toString(36).slice(2)}`, task_id: 't', session_id: 's', verb: 'create', class: 'instance', target: {}, params: {}, ...r };
};

export const decide = (req: CallRequest, state: Partial<EngineState> = {}) =>
  evaluate(req, load('session-default.yaml', 'session'), load('floor.yaml', 'floor'), { ...STATE, ...state });

export const allowFor = (req: CallRequest, state: Partial<EngineState> = {}): AllowDecision => {
  const d = decide(req, state);
  if (d.decision !== 'ALLOW') throw new Error(`expected ALLOW, got ${d.decision} ${d.rule_id}: ${d.reason}`);
  return d;
};
