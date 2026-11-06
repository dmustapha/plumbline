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
  /**
   * AG4-ENG-2: true only when label and tags were read from the live inventory by the broker for this id.
   * Anything else (absent included) is unresolved and fails closed for update/delete/put/restore.
   */
  resolved?: boolean;
}

/** Who issued the call. The broker sets it from the authenticated route, never from the body. Absent means 'sandbox'. */
export type Caller = 'sandbox' | 'owner';

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
  caller?: Caller;
}

/**
 * E-1: the fields a ledger row carries so the verifier can re-run `evaluate` later.
 * `evaluate` is a pure function of (request, state, session policy, floor policy): no I/O, no clock besides state.now_ms.
 */
export interface LedgerRequestFields {
  plan?: string;
  region?: string;
  request: { verb: Verb; class: ResourceClass; target: Target; params: Params };
}

export interface RuleMatch {
  verb?: Verb[];
  class?: ResourceClass[];
  target_id?: string[];
  label_prefix?: string[];
  label_not_prefix?: string[];
  tags_any?: string[];
  plan_not_in?: string[];
  /** A flat list applies to every matched class; a per-class map applies only to the classes it names. */
  region_not_in?: string[] | Partial<Record<ResourceClass, string[]>>;
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
  target_resolved?: boolean;
  object_state_unknown?: boolean;
  caller_owner?: boolean;
  playground_label_malformed?: boolean;
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
  /** AG4-ENG-6: binds the decision to one call. See requestHash. */
  target_id: string | null;
  request_hash: string;
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
