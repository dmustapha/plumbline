// File: packages/policy-engine/test/fixtures.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePolicy, type CallRequest, type EngineState, type PolicyDoc } from '../src/index.ts';

const dir = fileURLToPath(new URL('../../../policy/', import.meta.url));

export function loadPolicy(file: string, layer: 'session' | 'floor'): PolicyDoc {
  const r = parsePolicy(readFileSync(dir + file, 'utf8'), layer);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.policy;
}

export const session = loadPolicy('session-default.yaml', 'session');
export const floor = loadPolicy('floor.yaml', 'floor');

export const NOW = 1_000_000;

export function state(over: Partial<EngineState> = {}): EngineState {
  return {
    now_ms: NOW,
    rate_card: { fetched_at_ms: NOW - 1000, hourly: { 'vc2-1c-1gb': 0.007, 'vc2-1c-0.5gb': 0.005, 'vc2-2c-4gb': 0.027, 'vc2-64c-256gb': 5.1 } },
    session_spent_usd: 0,
    session_ceiling_usd: 1.5,
    global_spent_usd: 0,
    global_cap_usd: 10,
    live_worker_count: 0,
    max_instances: 4,
    kill_switch: false,
    session_tier: 'standard',
    tier_available: { observer: true, deployer: true, network: true, objstore: true, registry: true },
    object_versions: 2,
    restorable: true,
    bond: { enabled: false, free_usd: 3.5 },
    ...over,
  };
}

let n = 0;
export function req(over: Partial<CallRequest>): CallRequest {
  n += 1;
  return { request_id: `r${n}`, task_id: 't1', session_id: 's1', verb: 'list', class: 'instance', target: {}, params: {}, ...over };
}

export const prodDb = { id: 'i-prod', label: 'plumbline-prod-db', tags: ['protected'], resolved: true };
export const worker = { id: 'i-wk1', label: 'plumbline-wk-aaaa1111', tags: ['plumbline'], resolved: true };
export const vault = { id: 'fw-s1', label: 'plumbline-sa1b2c3d4-vault', tags: ['protected'], resolved: true };

/** AG4-ENG-7: a session layer that allows everything, so any DENY seen must come from the floor alone. */
export const allowAllSession: PolicyDoc = {
  version: 1, layer: 'session', hash: 'allow-all',
  rules: [{ id: 'custom-allow-all', effect: 'allow', priority: 1, match: {}, reason: 'weakened session' }],
};
/** An empty session layer: nothing allows anything, so only the floor's own denies are being tested via allowAllSession. */
export const emptySession: PolicyDoc = { version: 1, layer: 'session', hash: 'empty', rules: [] };
