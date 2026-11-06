// File: packages/policy-engine/src/types.ts
export type Verb = 'list' | 'create' | 'update' | 'delete' | 'put' | 'restore' | 'fetch' | 'read' | 'write';
export type ResourceClass =
  | 'instance' | 'firewall_group' | 'vpc' | 'registry' | 'bucket_object' | 'http' | 'policy' | 'ledger';
export type Effect = 'allow' | 'escalate' | 'deny';
export type DecisionKind = 'ALLOW' | 'ESCALATE' | 'DENY';
export type Tier = 'observer' | 'deployer' | 'network' | 'objstore' | 'registry';
export type LayerName = 'session' | 'floor' | 'engine';

export interface Target {
  id?: string;
  label?: string;
  tags?: string[];
}

export interface Params {
  plan?: string;
  region?: string;
  ttl_h?: number;
  label?: string;
  url?: string;
  key?: string;
  version_id?: string;
  name?: string;
  subnet?: string;
  subnet_size?: number;
  bond_usd?: number;
}

export interface CallRequest {
  request_id: string;
  task_id: string;
  session_id: string;
  verb: Verb;
  class: ResourceClass;
  target: Target;
  params: Params;
}

export interface RuleMatch {
  verb?: Verb[];
  class?: ResourceClass[];
  label_prefix?: string[];
  label_not_prefix?: string[];
  tags_any?: string[];
  plan_not_in?: string[];
  region_not_in?: string[];
}

export type CostRef = 'ceiling_remaining' | 'cap_remaining' | 'bond_free' | number;

export interface RuleWhen {
  projected_cost_gt?: CostRef;
  kill_switch?: boolean;
  rate_card_unavailable?: boolean;
  live_workers_gte?: 'max_instances' | number;
  tier_insufficient?: boolean;
  tier_unavailable?: boolean;
  egress_host_not_in?: string[];
  object_versions_lte?: number;
  restorable?: boolean;
  bond_enabled?: boolean;
  session_spent_gte_ceiling?: boolean;
}

export interface Rule {
  id: string;
  effect: Effect;
  priority: number;
  match: RuleMatch;
  when?: RuleWhen;
  reason: string;
}

export interface PolicyDoc {
  version: number;
  layer: 'session' | 'floor';
  rules: Rule[];
  hash: string;
}

export interface RateCard {
  fetched_at_ms: number;
  hourly: Record<string, number>;
}

export interface EngineState {
  now_ms: number;
  rate_card: RateCard | null;
  session_spent_usd: number;
  session_ceiling_usd: number;
  global_spent_usd: number;
  global_cap_usd: number;
  live_worker_count: number;
  max_instances: number;
  kill_switch: boolean;
  session_tier: 'observer' | 'standard';
  tier_available: Record<Tier, boolean>;
  object_versions: number | null;
  restorable: boolean | null;
  bond: { enabled: boolean; free_usd: number };
}

export interface LayerResult {
  layer: 'session' | 'floor';
  effect: Effect | null;
  rule_id: string | null;
  reason: string | null;
}

declare const allowBrand: unique symbol;

interface DecisionBase {
  request_id: string;
  verb: Verb;
  class: ResourceClass;
  rule_id: string;
  layer: LayerName;
  reason: string;
  policy_version: string;
  layers: LayerResult[];
  projected_cost_usd: number;
}

export interface DenyDecision extends DecisionBase {
  decision: 'DENY';
}
export interface EscalateDecision extends DecisionBase {
  decision: 'ESCALATE';
}
export interface AllowDecision extends DecisionBase {
  decision: 'ALLOW';
  readonly [allowBrand]: true;
}
export type Decision = AllowDecision | EscalateDecision | DenyDecision;

export type StatusToken =
  | 'ARGS_INVALID' | 'POLICY_INVALID' | 'SIG_REQUIRED' | 'SIG_INVALID' | 'RATE_LIMITED'
  | 'AUTH_TASK_TOKEN_INVALID' | 'SANDBOX_TIMEOUT' | 'SANDBOX_OOM' | 'SANDBOX_PIDS'
  | 'SANDBOX_DESTROYED' | 'SANDBOX_STUCK' | 'REWIND_UNAVAILABLE' | 'WATCHDOG_DEGRADED';
