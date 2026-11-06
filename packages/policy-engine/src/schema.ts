// File: packages/policy-engine/src/schema.ts
import { VERB_CLASS, isAllowedRuleId } from './catalog.ts';

const EFFECTS = ['allow', 'escalate', 'deny'];
const VERBS = ['list', 'create', 'update', 'delete', 'put', 'restore', 'fetch', 'read', 'write'];
const CLASSES = Object.keys(VERB_CLASS);
const MATCH_KEYS = ['verb', 'class', 'target_id', 'label_prefix', 'label_not_prefix', 'tags_any', 'plan_not_in', 'region_not_in'];
const WHEN_KEYS = [
  'projected_cost_gt', 'kill_switch', 'rate_card_unavailable', 'live_workers_gte', 'tier_insufficient',
  'tier_unavailable', 'egress_host_not_in', 'object_versions_lte', 'restorable', 'bond_enabled',
  'session_spent_gte_ceiling', 'target_resolved', 'object_state_unknown', 'caller_owner', 'playground_label_malformed',
];
const COST_REFS = ['ceiling_remaining', 'cap_remaining', 'bond_free'];

export interface SchemaError {
  path: (string | number)[];
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkStringList(v: unknown, allowed: string[] | null, path: (string | number)[], out: SchemaError[]): void {
  if (!Array.isArray(v) || v.length === 0 || v.length > 32) {
    out.push({ path, message: 'must be a non-empty list (max 32)' });
    return;
  }
  v.forEach((item, i) => {
    if (typeof item !== 'string' || item.length > 120) out.push({ path: [...path, i], message: 'must be a short string' });
    else if (allowed && !allowed.includes(item)) out.push({ path: [...path, i], message: `unknown value "${item}"` });
  });
}

function checkMatch(m: unknown, path: (string | number)[], out: SchemaError[]): void {
  if (!isRecord(m)) return void out.push({ path, message: 'match must be a mapping' });
  for (const k of Object.keys(m)) {
    if (!MATCH_KEYS.includes(k)) out.push({ path: [...path, k], message: `unknown match key "${k}"` });
  }
  if (m.verb !== undefined) checkStringList(m.verb, VERBS, [...path, 'verb'], out);
  if (m.class !== undefined) checkStringList(m.class, CLASSES, [...path, 'class'], out);
  for (const k of ['target_id', 'label_prefix', 'label_not_prefix', 'tags_any', 'plan_not_in', 'region_not_in']) {
    if (m[k] !== undefined) checkStringList(m[k], null, [...path, k], out);
  }
}

function checkWhen(w: unknown, path: (string | number)[], out: SchemaError[]): void {
  if (!isRecord(w)) return void out.push({ path, message: 'when must be a mapping' });
  for (const [k, v] of Object.entries(w)) {
    if (!WHEN_KEYS.includes(k)) out.push({ path: [...path, k], message: `unknown when key "${k}"` });
    else if (k === 'projected_cost_gt') {
      const ok = typeof v === 'number' || (typeof v === 'string' && COST_REFS.includes(v));
      if (!ok) out.push({ path: [...path, k], message: 'must be a number or one of ' + COST_REFS.join(', ') });
    } else if (k === 'live_workers_gte') {
      if (!(typeof v === 'number' || v === 'max_instances')) out.push({ path: [...path, k], message: 'number or max_instances' });
    } else if (k === 'egress_host_not_in') checkStringList(v, null, [...path, k], out);
    else if (k === 'object_versions_lte') {
      if (typeof v !== 'number') out.push({ path: [...path, k], message: 'must be a number' });
    } else if (typeof v !== 'boolean') out.push({ path: [...path, k], message: 'must be true or false' });
  }
}

export function validateShape(doc: unknown): SchemaError[] {
  const out: SchemaError[] = [];
  if (!isRecord(doc)) return [{ path: [], message: 'policy must be a mapping with version and rules' }];
  for (const k of Object.keys(doc)) {
    if (k !== 'version' && k !== 'rules') out.push({ path: [k], message: `unknown top-level key "${k}"` });
  }
  if (!Number.isInteger(doc.version) || (doc.version as number) < 1) out.push({ path: ['version'], message: 'must be an integer >= 1' });
  const rules = doc.rules;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 200) {
    out.push({ path: ['rules'], message: 'rules must be a list of 1..200 entries' });
    return out;
  }
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    const p: (string | number)[] = ['rules', i];
    if (!isRecord(r)) return void out.push({ path: p, message: 'rule must be a mapping' });
    for (const k of Object.keys(r)) {
      if (!['id', 'effect', 'priority', 'match', 'when', 'reason'].includes(k)) out.push({ path: [...p, k], message: `unknown rule key "${k}"` });
    }
    if (typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(r.id)) out.push({ path: [...p, 'id'], message: 'id must be lowercase-with-hyphens' });
    else if (!isAllowedRuleId(r.id)) out.push({ path: [...p, 'id'], message: `id "${r.id}" is not in the catalog (use a custom- prefix)` });
    else if (seen.has(r.id)) out.push({ path: [...p, 'id'], message: `duplicate rule id "${r.id}"` });
    else seen.add(r.id);
    if (typeof r.effect !== 'string' || !EFFECTS.includes(r.effect)) out.push({ path: [...p, 'effect'], message: 'effect must be allow, escalate or deny' });
    if (!Number.isInteger(r.priority) || (r.priority as number) < 0 || (r.priority as number) > 1000) out.push({ path: [...p, 'priority'], message: 'priority must be an integer 0..1000' });
    if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > 200) out.push({ path: [...p, 'reason'], message: 'reason must be 1..200 characters' });
    checkMatch(r.match, [...p, 'match'], out);
    if (r.when !== undefined) checkWhen(r.when, [...p, 'when'], out);
  });
  return out;
}
