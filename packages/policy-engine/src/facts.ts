// File: packages/policy-engine/src/facts.ts
import { tierFor } from './catalog.ts';
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
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function projectCost(req: CallRequest, state: EngineState): { cost: number; hourly: number; unavailable: boolean } {
  if (req.verb !== 'create' || req.class !== 'instance') return { cost: 0, hourly: 0, unavailable: false };
  const card = state.rate_card;
  if (!card || state.now_ms - card.fetched_at_ms > RATE_CARD_MAX_AGE_MS) return { cost: 0, hourly: 0, unavailable: true };
  const plan = req.params.plan;
  const hourly = plan !== undefined ? card.hourly[plan] : undefined;
  if (hourly === undefined) return { cost: 0, hourly: 0, unavailable: false };
  const ttl = Math.max(1, Math.ceil(req.params.ttl_h ?? 1));
  return { cost: Math.round(hourly * ttl * 1e6) / 1e6, hourly, unavailable: false };
}

export function deriveFacts(req: CallRequest, state: EngineState): Facts {
  const { cost, hourly, unavailable } = projectCost(req, state);
  return {
    label: req.target.label ?? req.params.label,
    tags: (req.target.tags ?? []).map((t) => t.toLowerCase()),
    required_tier: tierFor(req.verb, req.class),
    projected_cost_usd: cost,
    hourly_usd: hourly,
    ceiling_remaining: Math.max(0, state.session_ceiling_usd - state.session_spent_usd),
    cap_remaining: Math.max(0, state.global_cap_usd - state.global_spent_usd),
    bond_free: state.bond.free_usd,
    host: hostOf(req.params.url),
    rate_card_unavailable: unavailable,
  };
}
