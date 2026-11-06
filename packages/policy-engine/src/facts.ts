// File: packages/policy-engine/src/facts.ts
import { PLAYGROUND_LABEL_PREFIX, PLAYGROUND_LABEL_RE, tierFor } from './catalog.ts';
import type { CallRequest, EngineState, Tier } from './types.ts';

export const RATE_CARD_MAX_AGE_MS = 10 * 60 * 1000;

export interface Facts {
  label: string | undefined;
  tags: string[];
  required_tier: Tier | null;
  projected_cost_usd: number;
  hourly_usd: number;
  ceiling_remaining: number;
  cap_remaining: number;
  bond_free: number;
  host: string;
  rate_card_unavailable: boolean;
  resolved: boolean;
  target_id: string | undefined;
  caller_owner: boolean;
  object_state_unknown: boolean;
  playground_label_malformed: boolean;
}

export function ttlIsValid(ttl: unknown): boolean {
  return ttl === undefined || (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0);
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const NO_COST = { cost: 0, hourly: 0 };

export function projectCost(req: CallRequest, state: EngineState): { cost: number; hourly: number; unavailable: boolean } {
  if (req.verb !== 'create' || req.class !== 'instance') return { ...NO_COST, unavailable: false };
  const card = state.rate_card;
  if (!card || state.now_ms - card.fetched_at_ms > RATE_CARD_MAX_AGE_MS) return { ...NO_COST, unavailable: true };
  const plan = req.params.plan;
  const hourly = typeof plan === 'string' && Object.hasOwn(card.hourly, plan) ? card.hourly[plan] : undefined;
  // AG4-ENG-5: a plan the rate card does not price, or an invalid ttl, is unpriceable and fails closed.
  if (typeof hourly !== 'number' || !Number.isFinite(hourly) || hourly < 0 || !ttlIsValid(req.params.ttl_h)) return { ...NO_COST, unavailable: true };
  const ttl = Math.max(1, Math.ceil(req.params.ttl_h ?? 1));
  return { cost: Math.round(hourly * ttl * 1e6) / 1e6, hourly, unavailable: false };
}

/** AG4-ENG-2: only the create verb has no inventory entry yet, so only create may name its own label. */
function labelOf(req: CallRequest): string | undefined {
  return req.verb === 'create' ? (req.params.label ?? req.target.label) : req.target.label;
}

function objectStateUnknown(req: CallRequest, state: EngineState): boolean {
  if (req.verb !== 'delete' || req.class !== 'bucket_object') return false;
  return state.object_versions === null || (state.bond.enabled && state.restorable === null);
}

export function deriveFacts(req: CallRequest, state: EngineState): Facts {
  const { cost, hourly, unavailable } = projectCost(req, state);
  const label = labelOf(req);
  return {
    label,
    tags: (req.target.tags ?? []).map((t) => t.toLowerCase()),
    required_tier: tierFor(req.verb, req.class),
    projected_cost_usd: cost,
    hourly_usd: hourly,
    ceiling_remaining: Math.max(0, state.session_ceiling_usd - state.session_spent_usd),
    cap_remaining: Math.max(0, state.global_cap_usd - state.global_spent_usd),
    bond_free: state.bond.free_usd,
    host: hostOf(req.params.url),
    rate_card_unavailable: unavailable,
    resolved: req.target.resolved === true,
    target_id: typeof req.target.id === 'string' ? req.target.id.trim().toLowerCase() : undefined,
    caller_owner: req.caller === 'owner',
    object_state_unknown: objectStateUnknown(req, state),
    playground_label_malformed: label !== undefined && label.startsWith(PLAYGROUND_LABEL_PREFIX) && !PLAYGROUND_LABEL_RE.test(label),
  };
}
