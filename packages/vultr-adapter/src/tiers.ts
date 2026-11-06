// File: packages/vultr-adapter/src/tiers.ts
import type { Tier } from '@plumbline/policy-engine';
import type { SpendGate } from '@plumbline/ledger';
import { VultrError, VultrHttp } from './http.ts';

export interface TierKeyConfig {
  observer: string | null;
  deployer: string | null;
  network: string | null;
  registry: string | null;
}

export class TierUnavailable extends Error {
  constructor(readonly tier: Tier) {
    super(`tier-key-unavailable: ${tier}`);
  }
}

export interface SelfTestResult {
  call: string;
  tier: Tier;
  status: number;
  body: unknown;
  ok: boolean;
}

export class TierKeys {
  readonly #http: Partial<Record<Tier, VultrHttp>> = {};
  readonly #down = new Set<Tier>();

  constructor(keys: TierKeyConfig, gate: SpendGate, fetchImpl?: typeof fetch) {
    for (const tier of ['observer', 'deployer', 'network', 'registry'] as const) {
      const k = keys[tier];
      if (k) this.#http[tier] = new VultrHttp({ apiKey: k, gate, fetchImpl });
    }
  }

  availability(): Record<Tier, boolean> {
    const has = (t: Tier): boolean => this.#http[t] !== undefined && !this.#down.has(t);
    return { observer: has('observer'), deployer: has('deployer'), network: has('network'), registry: has('registry'), objstore: true };
  }

  http(tier: Tier): VultrHttp {
    const h = this.#http[tier];
    if (!h || this.#down.has(tier)) throw new TierUnavailable(tier);
    return h;
  }

  /** A 401 (IP lock after a VM IP change) marks the tier down; there is NO fallback to a stronger key. */
  noteFailure(tier: Tier, e: unknown): void {
    if (e instanceof VultrError && e.status === 401) this.#down.add(tier);
  }

  clearDown(): void {
    this.#down.clear();
  }

  async aclSelfTest(sessionId: string): Promise<SelfTestResult[]> {
    const out: SelfTestResult[] = [];
    const observer = this.http('observer');
    try {
      await observer.request('POST', '/instances', {
        session_id: sessionId, body: { region: 'ewr', plan: 'plumbline-selftest-invalid', os_id: 2136, label: 'plumbline-selftest' },
      });
      out.push({ call: 'POST /instances', tier: 'observer', status: 202, body: 'UNEXPECTED: accepted', ok: false });
    } catch (e) {
      const v = e as VultrError;
      out.push({ call: 'POST /instances', tier: 'observer', status: v.status ?? 0, body: v.body ?? String(e), ok: v.status === 403 });
    }
    try {
      await observer.request('GET', '/instances', { session_id: sessionId, query: { per_page: 1 } });
      out.push({ call: 'GET /instances', tier: 'observer', status: 200, body: 'list ok', ok: true });
    } catch (e) {
      const v = e as VultrError;
      out.push({ call: 'GET /instances', tier: 'observer', status: v.status ?? 0, body: v.body ?? String(e), ok: false });
    }
    return out;
  }
}
