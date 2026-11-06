// File: packages/policy-engine/src/evaluate.ts
import { mint, isGenuineDecision } from './brand.ts';
import { isKnownCall } from './catalog.ts';
import { deriveFacts, ttlIsValid, type Facts } from './facts.ts';
import { requestHash } from './hash.ts';
import { createHash } from 'node:crypto';
import type {
  AllowDecision, CallRequest, CostRef, Decision, DenyDecision, Effect, EngineState,
  EscalateDecision, LayerResult, PolicyDoc, Rule, RuleMatch,
} from './types.ts';

const RANK: Record<Effect, number> = { allow: 1, escalate: 2, deny: 3 };

export { isGenuineDecision };

export function isGenuineAllow(d: unknown): d is AllowDecision {
  return isGenuineDecision(d) && d.decision === 'ALLOW';
}

/**
 * AG4-ENG-6 / AG4-ADP-2: throws unless `allow` is an engine-minted ALLOW for exactly this call
 * (verb, class, target id and canonical request hash all match). Every executor calls this before acting.
 */
export function assertAllow(allow: AllowDecision, req: CallRequest): void {
  if (!isGenuineAllow(allow)) throw new Error('NOT_AN_ENGINE_ALLOW');
  if (allow.verb !== req.verb || allow.class !== req.class) throw new Error('ALLOW_REQUEST_MISMATCH: verb or class');
  if (allow.target_id !== (req.target?.id ?? null)) throw new Error('ALLOW_REQUEST_MISMATCH: target');
  if (allow.request_hash !== requestHash(req)) throw new Error('ALLOW_REQUEST_MISMATCH: request_hash');
}

function startsWithAny(value: string | undefined, prefixes: string[]): boolean {
  return value !== undefined && prefixes.some((p) => value.startsWith(p));
}

function costRef(ref: CostRef, f: Facts): number {
  if (typeof ref === 'number') return ref;
  if (ref === 'ceiling_remaining') return f.ceiling_remaining;
  if (ref === 'cap_remaining') return f.cap_remaining;
  return f.bond_free;
}

function whenHolds(rule: Rule, req: CallRequest, f: Facts, s: EngineState): boolean {
  const w = rule.when;
  if (!w) return true;
  // AG4-ENG-3: written as !(cost <= ref) so a NaN cost makes the rule hold instead of silently not firing.
  if (w.projected_cost_gt !== undefined && f.projected_cost_usd <= costRef(w.projected_cost_gt, f)) return false;
  if (w.kill_switch !== undefined && s.kill_switch !== w.kill_switch) return false;
  if (w.rate_card_unavailable !== undefined && f.rate_card_unavailable !== w.rate_card_unavailable) return false;
  if (w.live_workers_gte !== undefined) {
    const limit = w.live_workers_gte === 'max_instances' ? s.max_instances : w.live_workers_gte;
    if (!(s.live_worker_count >= limit)) return false;
  }
  if (w.tier_insufficient !== undefined) {
    const insufficient = s.session_tier === 'observer' && f.required_tier !== null && f.required_tier !== 'observer';
    if (insufficient !== w.tier_insufficient) return false;
  }
  if (w.tier_unavailable !== undefined) {
    const unavailable = f.required_tier !== null && !s.tier_available[f.required_tier];
    if (unavailable !== w.tier_unavailable) return false;
  }
  if (w.egress_host_not_in !== undefined && w.egress_host_not_in.includes(f.host)) return false;
  // AG4-ENG-4: an unknown (null) fact satisfies deny/escalate rules and never an allow rule.
  const unknownHolds = rule.effect !== 'allow';
  if (w.object_versions_lte !== undefined) {
    if (s.object_versions === null ? !unknownHolds : !(s.object_versions <= w.object_versions_lte)) return false;
  }
  if (w.restorable !== undefined) {
    if (s.restorable === null ? !unknownHolds : s.restorable !== w.restorable) return false;
  }
  if (w.bond_enabled !== undefined && s.bond.enabled !== w.bond_enabled) return false;
  if (w.session_spent_gte_ceiling !== undefined) {
    const spent = s.session_spent_usd >= s.session_ceiling_usd;
    if (spent !== w.session_spent_gte_ceiling) return false;
  }
  if (w.target_resolved !== undefined && f.resolved !== w.target_resolved) return false;
  if (w.object_state_unknown !== undefined && f.object_state_unknown !== w.object_state_unknown) return false;
  if (w.caller_owner !== undefined && f.caller_owner !== w.caller_owner) return false;
  if (w.playground_label_malformed !== undefined && f.playground_label_malformed !== w.playground_label_malformed) return false;
  void req;
  return true;
}

/** True when the request names a region outside the allow-list for its class (a class the map omits is unconstrained). */
function regionOutside(list: NonNullable<RuleMatch['region_not_in']>, req: CallRequest): boolean {
  const allowed = Array.isArray(list) ? list : list[req.class];
  return allowed !== undefined && !(req.params.region !== undefined && allowed.includes(req.params.region));
}

function matches(rule: Rule, req: CallRequest, f: Facts, s: EngineState): boolean {
  const m = rule.match;
  if (m.verb && !m.verb.includes(req.verb)) return false;
  if (m.class && !m.class.includes(req.class)) return false;
  if (m.target_id && !(f.target_id !== undefined && m.target_id.includes(f.target_id))) return false;
  if (m.label_prefix && !startsWithAny(f.label, m.label_prefix)) return false;
  if (m.label_not_prefix && startsWithAny(f.label, m.label_not_prefix)) return false;
  if (m.tags_any && !m.tags_any.some((t) => f.tags.includes(t.toLowerCase()))) return false;
  if (m.plan_not_in && (req.params.plan !== undefined && m.plan_not_in.includes(req.params.plan))) return false;
  if (m.region_not_in && !regionOutside(m.region_not_in, req)) return false;
  return whenHolds(rule, req, f, s);
}

function render(template: string, req: CallRequest, f: Facts, s: EngineState): string {
  const ttl = ttlIsValid(req.params.ttl_h) ? Math.max(1, Math.ceil(req.params.ttl_h ?? 1)) : 0;
  const vars: Record<string, string> = {
    cost: f.projected_cost_usd.toFixed(4),
    hourly: f.hourly_usd.toFixed(4),
    remaining: f.ceiling_remaining.toFixed(4),
    cap_remaining: f.cap_remaining.toFixed(4),
    bond_free: f.bond_free.toFixed(2),
    workers: String(s.live_worker_count),
    max: String(s.max_instances),
    host: f.host || '(none)',
    ttl: String(ttl),
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

interface LayerPick {
  result: LayerResult;
  rule: Rule | null;
}

function evalLayer(policy: PolicyDoc, req: CallRequest, f: Facts, s: EngineState): LayerPick {
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!matches(rule, req, f, s)) continue;
    if (best === null) best = rule;
    else if (RANK[rule.effect] > RANK[best.effect]) best = rule;
    else if (RANK[rule.effect] === RANK[best.effect]) {
      if (rule.priority > best.priority || (rule.priority === best.priority && rule.id < best.id)) best = rule;
    }
  }
  const layer = policy.layer;
  if (best === null) return { result: { layer, effect: null, rule_id: null, reason: null }, rule: null };
  return { result: { layer, effect: best.effect, rule_id: best.id, reason: render(best.reason, req, f, s) }, rule: best };
}

function versionString(a: PolicyDoc, b: PolicyDoc): string {
  return `session:${a.version}:${a.hash.slice(0, 12)}|floor:${b.version}:${b.hash.slice(0, 12)}`;
}

function safeRequestHash(req: CallRequest): string | null {
  try {
    return requestHash(req);
  } catch {
    return null;
  }
}

function engineDeny(req: CallRequest, hash: string | null, rule_id: string, reason: string, policy_version: string): DenyDecision {
  return mint<DenyDecision>({
    request_id: req.request_id, verb: req.verb, class: req.class, policy_version, decision: 'DENY', rule_id, layer: 'engine',
    projected_cost_usd: 0, layers: [], reason, target_id: req.target?.id ?? null,
    request_hash: hash ?? createHash('sha256').update(`unhashable:${req.request_id}`).digest('hex'),
  });
}

/** Pure function of (req, sessionPolicy, floorPolicy, state): no I/O. The verifier re-runs it from a ledger row (E-1). */
export function evaluate(req: CallRequest, sessionPolicy: PolicyDoc, floorPolicy: PolicyDoc, state: EngineState): Decision {
  const policy_version = versionString(sessionPolicy, floorPolicy);
  const hash = safeRequestHash(req);
  if (!isKnownCall(req.verb, req.class)) {
    return engineDeny(req, hash, 'default-deny', 'no rule allows this: verb or class is outside the catalog', policy_version);
  }
  // AG4-ENG-3: engine-level, so it holds even if both policy layers are weakened or empty.
  if (!ttlIsValid(req.params.ttl_h)) return engineDeny(req, hash, 'ttl-invalid', 'ttl_h must be a finite number above zero', policy_version);
  if (hash === null) return engineDeny(req, hash, 'args-invalid', 'request parameters cannot be canonicalised (NaN, Infinity or a non-JSON value)', policy_version);
  const base = { request_id: req.request_id, verb: req.verb, class: req.class, policy_version, target_id: req.target?.id ?? null, request_hash: hash };
  const f = deriveFacts(req, state);
  const s = evalLayer(sessionPolicy, req, f, state);
  const fl = evalLayer(floorPolicy, req, f, state);
  const layers = [s.result, fl.result];
  const common = { ...base, layers, projected_cost_usd: f.projected_cost_usd };

  const pickFor = (effect: Effect): LayerResult | null => {
    if (s.result.effect === effect) return s.result;
    if (fl.result.effect === effect) return fl.result;
    return null;
  };
  const denyHit = pickFor('deny');
  if (denyHit) {
    return mint<DenyDecision>({ ...common, decision: 'DENY', rule_id: denyHit.rule_id as string, layer: denyHit.layer, reason: denyHit.reason as string });
  }
  const escHit = pickFor('escalate');
  if (escHit) {
    return mint<EscalateDecision>({ ...common, decision: 'ESCALATE', rule_id: escHit.rule_id as string, layer: escHit.layer, reason: escHit.reason as string });
  }
  if (s.result.effect === 'allow') {
    return mint<AllowDecision>({ ...common, decision: 'ALLOW', rule_id: s.result.rule_id as string, layer: 'session', reason: s.result.reason as string } as Omit<AllowDecision, never>);
  }
  return mint<DenyDecision>({ ...common, decision: 'DENY', rule_id: 'default-deny', layer: 'floor', reason: 'no rule allows this' });
}
