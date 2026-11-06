import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, parsePolicy, type CallRequest, type Decision, type EngineState } from '@plumbline/policy-engine';

const p = (f: string, l: 'session' | 'floor') => {
  const r = parsePolicy(readFileSync(fileURLToPath(new URL(`../../../../policy/${f}`, import.meta.url)), 'utf8'), l);
  if (!r.ok) throw new Error('bad policy');
  return r.policy;
};
export const STATE: EngineState = {
  now_ms: 1, rate_card: { fetched_at_ms: 1, hourly: { 'vc2-1c-1gb': 0.007 } }, session_spent_usd: 0, session_ceiling_usd: 1.5, global_spent_usd: 0, global_cap_usd: 10,
  live_worker_count: 0, max_instances: 4, kill_switch: false, session_tier: 'standard',
  tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
  object_versions: null, restorable: null, bond: { enabled: false, free_usd: 0 },
};
let n = 0;
export const req = (r: Partial<CallRequest> = {}): CallRequest => {
  n += 1;
  return { request_id: `r-${n}`, task_id: 't', session_id: 's', verb: 'list', class: 'instance', target: {}, params: {}, ...r };
};
export const decide = (r: CallRequest): Decision => evaluate(r, p('session-default.yaml', 'session'), p('floor.yaml', 'floor'), STATE);
export const createReq = (label = 'plumbline-wk-1'): CallRequest => req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label } });
export const deleteReq = (): CallRequest => req({ verb: 'delete', class: 'instance', target: { id: 'i-1', label: 'plumbline-wk-1', tags: ['plumbline'], resolved: true } });
