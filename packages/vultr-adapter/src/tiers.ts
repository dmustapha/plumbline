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
  #objstore: { healthy(): boolean } | null = null;

  constructor(keys: TierKeyConfig, gate: SpendGate, fetchImpl?: typeof fetch) {
    for (const tier of ['observer', 'deployer', 'network', 'registry'] as const) {
      const k = keys[tier];
      if (k) this.#http[tier] = new VultrHttp({ apiKey: k, gate, fetchImpl, onFailure: (e) => this.noteFailure(tier, e) });
    }
  }

  availability(): Record<Tier, boolean> {
    const has = (t: Tier): boolean => this.#http[t] !== undefined && !this.#down.has(t);
    return { observer: has('observer'), deployer: has('deployer'), network: has('network'), registry: has('registry'), objstore: this.#objstore !== null && this.#objstore.healthy() };
  }

  /** AG4-ADP-7: objstore is available only while an S3 store with credentials exists and its last call succeeded. */
  registerObjstore(store: { healthy(): boolean } | null): void {
    this.#objstore = store;
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

  /**
   * AG4-ADP-8: every key must be refused (403) for what its tier may not do. Probes carry an invalid payload so an
   * over-scoped key answers 400/422 (permitted but malformed) and creates nothing; any non-403 on a forbidden call is a FAIL.
   */
  async aclSelfTest(sessionId: string): Promise<SelfTestResult[]> {
    const out: SelfTestResult[] = [];
    for (const probe of ACL_PROBES) {
      if (!this.availability()[probe.tier]) continue;
      const http = this.http(probe.tier);
      const call = `${probe.method} ${probe.path}`;
      try {
        await http.request(probe.method, probe.path, { session_id: sessionId, body: probe.body, query: probe.method === 'GET' ? { per_page: 1 } : undefined });
        out.push({ call, tier: probe.tier, status: 200, body: probe.expect === 200 ? 'ok' : 'UNEXPECTED: accepted', ok: probe.expect === 200 });
      } catch (e) {
        const v = e as VultrError;
        out.push({ call, tier: probe.tier, status: v.status ?? 0, body: v.body ?? String(e), ok: v.status === probe.expect });
      }
    }
    return out;
  }
}

interface AclProbe {
  tier: Tier;
  method: 'GET' | 'POST';
  path: string;
  expect: 200 | 403;
  body?: unknown;
}

const INVALID_INSTANCE = { region: 'ewr', plan: 'plumbline-selftest-invalid', os_id: 2136, label: 'plumbline-selftest' };
const INVALID_FIREWALL = { description: '' };
const INVALID_USER = { name: '' };

const ACL_PROBES: AclProbe[] = [
  { tier: 'observer', method: 'POST', path: '/instances', expect: 403, body: INVALID_INSTANCE },
  { tier: 'observer', method: 'POST', path: '/firewalls', expect: 403, body: INVALID_FIREWALL },
  { tier: 'observer', method: 'POST', path: '/users', expect: 403, body: INVALID_USER },
  { tier: 'observer', method: 'GET', path: '/instances', expect: 200 },
  { tier: 'deployer', method: 'POST', path: '/firewalls', expect: 403, body: INVALID_FIREWALL },
  { tier: 'deployer', method: 'GET', path: '/users', expect: 403 },
  { tier: 'deployer', method: 'POST', path: '/users', expect: 403, body: INVALID_USER },
  { tier: 'network', method: 'POST', path: '/instances', expect: 403, body: INVALID_INSTANCE },
  { tier: 'network', method: 'GET', path: '/users', expect: 403 },
  { tier: 'registry', method: 'POST', path: '/instances', expect: 403, body: INVALID_INSTANCE },
  { tier: 'registry', method: 'POST', path: '/firewalls', expect: 403, body: INVALID_FIREWALL },
  { tier: 'registry', method: 'GET', path: '/users', expect: 403 },
];
