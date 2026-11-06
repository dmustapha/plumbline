// File: packages/vultr-adapter/src/plans.ts
import type { RateCard } from '@plumbline/policy-engine';
import type { VultrHttp } from './http.ts';

export async function fetchRateCard(http: VultrHttp, now: number = Date.now()): Promise<RateCard> {
  const res = await http.request<{ plans?: { id: string; hourly_cost?: number; monthly_cost?: number }[] }>('GET', '/plans', {
    session_id: 'system', query: { per_page: 500 },
  });
  const hourly: Record<string, number> = {};
  for (const p of res.plans ?? []) {
    if (typeof p.hourly_cost === 'number') hourly[p.id] = p.hourly_cost;
  }
  if (Object.keys(hourly).length === 0) throw new Error('rate card empty');
  return { fetched_at_ms: now, hourly };
}

export class RateCardCache {
  #card: RateCard | null = null;
  constructor(private readonly http: VultrHttp, private readonly clock: () => number = Date.now) {}

  async refresh(): Promise<void> {
    try {
      this.#card = await fetchRateCard(this.http, this.clock());
    } catch {
      /* keep the previous card; the engine fails closed once it is older than ten minutes */
    }
  }

  get(): RateCard | null {
    return this.#card;
  }
}
