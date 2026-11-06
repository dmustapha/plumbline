// File: packages/policy-engine/src/evaluate.ts
import { isKnownCall } from './catalog.ts';
import { deriveFacts, type Facts } from './facts.ts';
import type {
  AllowDecision, CallRequest, CostRef, Decision, DenyDecision, Effect, EngineState,
  EscalateDecision, LayerResult, PolicyDoc, Rule,
} from './types.ts';

const genuine = new WeakSet<object>();
const RANK: Record<Effect, number> = { allow: 1, escalate: 2, deny: 3 };

export function isGenuineDecision(d: unknown): d is Decision {
  return typeof d === 'object' && d !== null && genuine.has(d);
}

export function isGenuineAllow(d: unknown): d is AllowDecision {
  return isGenuineDecision(d) && d.decision === 'ALLOW';
}

export function assertAllow(d: unknown): asserts d is AllowDecision {
  if (!isGenuineAllow(d)) throw new Error('NOT_AN_ENGINE_ALLOW');
}

function mint<T extends Decision>(d: Omit<T, never>): T {
  const frozen = Object.freeze({ ...d }) as T;
  genuine.add(frozen);
  return frozen;
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
  if (w.projected_cost_gt !== undefined && !(f.projected_cost_usd > costRef(w.projected_cost_gt, f))) return false;
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
  if (w.object_versions_lte !== undefined && !(s.object_versions !== null && s.object_versions <= w.object_versions_lte)) return false;
  if (w.restorable !== undefined && s.restorable !== w.restorable) return false;
  if (w.bond_enabled !== undefined && s.bond.enabled !== w.bond_enabled) return false;
  if (w.session_spent_gte_ceiling !== undefined) {
    const spent = s.session_spent_usd >= s.session_ceiling_usd;
    if (spent !== w.session_spent_gte_ceiling) return false;
  }
  void req;
  return true;
}

function matches(rule: Rule, req: CallRequest, f: Facts, s: EngineState): boolean {
  const m = rule.match;
  if (m.verb && !m.verb.includes(req.verb)) return false;
  if (m.class && !m.class.includes(req.class)) return false;
  if (m.label_prefix && !startsWithAny(f.label, m.label_prefix)) return false;
  if (m.label_not_prefix && startsWithAny(f.label, m.label_not_prefix)) return false;
  if (m.tags_any && !m.tags_any.some((t) => f.tags.includes(t.toLowerCase()))) return false;
  if (m.plan_not_in && (req.params.plan !== undefined && m.plan_not_in.includes(req.params.plan))) return false;
  if (m.region_not_in && (req.params.region !== undefined && m.region_not_in.includes(req.params.region))) return false;
  return whenHolds(rule, req, f, s);
}

function render(template: string, req: CallRequest, f: Facts, s: EngineState): string {
  const ttl = Math.max(1, Math.ceil(req.params.ttl_h ?? 1));
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

export function evaluate(req: CallRequest, sessionPolicy: PolicyDoc, floorPolicy: PolicyDoc, state: EngineState): Decision {
  const policy_version = versionString(sessionPolicy, floorPolicy);
  const base = { request_id: req.request_id, verb: req.verb, class: req.class, policy_version };
  if (!isKnownCall(req.verb, req.class)) {
    const d: Omit<DenyDecision, never> = {
      ...base, decision: 'DENY', rule_id: 'default-deny', layer: 'engine', projected_cost_usd: 0, layers: [],
      reason: 'no rule allows this: verb or class is outside the catalog',
    };
    return mint<DenyDecision>(d);
  }
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

export function approveEscalation(d: EscalateDecision): AllowDecision {
  if (!isGenuineDecision(d) || d.decision !== 'ESCALATE') throw new Error('NOT_AN_ENGINE_ESCALATION');
  const floor = d.layers.find((l) => l.layer === 'floor');
  if (floor && floor.effect === 'deny') throw new Error('FLOOR_DENY_CANNOT_BE_APPROVED');
  return mint<AllowDecision>({ ...d, decision: 'ALLOW', layer: 'engine', reason: `approved escalation of ${d.rule_id}` } as Omit<AllowDecision, never>);
}
