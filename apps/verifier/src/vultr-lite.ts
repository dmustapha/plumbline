// File: apps/verifier/src/vultr-lite.ts
// The verifier's only Vultr surface: list calls under the observer-tier (view-only) key (KP-P2: instances, VPCs, registries return 200).
// The VM-2 processes have no dollar ledger, so they use a call-count budget gate that implements the same SpendGate interface as the
// broker's ledger; it is not a bypass: it refuses above 600 calls per minute. No create/update/delete constructor is used here.
import type { SpendGate, SpendResult } from '@plumbline/ledger';
import { Registries, TIER_ACL, VultrHttp, Vpcs } from '@plumbline/vultr-adapter';

export class CallBudgetGate implements SpendGate {
  #window: number[] = [];
  constructor(private readonly perMinute = 600, private readonly clock: () => number = Date.now) {}
  charge(kind: 'vultr' | 's3' | 'vsi'): SpendResult {
    const now = this.clock();
    this.#window = this.#window.filter((t) => now - t < 60_000);
    if (kind !== 'vultr' || this.#window.length >= this.perMinute) return { ok: false, reason: 'global-cap-exceeded' };
    this.#window.push(now);
    return { ok: true, receipt: { kind, estimate_usd: 0, settle: () => undefined }, remaining_session: 0, remaining_global: 0 };
  }
}

export interface LiveResource {
  id: string;
  class: 'instance' | 'vpc' | 'registry';
  label: string;
  status: string;
  /** instances only; '' for classes without one (CO-2 H-3) */
  power_status: string;
  plan: string;
  region: string;
  /** instances only; '' otherwise (CO-2 H-3) */
  os: string;
}

/** `at` is the time the poll STARTED (AG4-PRD-7: a ledger row newer than this is in flight, not missing) */
export type Snapshot = { ok: true; at: number; live: LiveResource[] } | { ok: false; at: number; error: string };

export function makeHttp(key: string, fetchImpl?: typeof fetch, gate: SpendGate = new CallBudgetGate()): VultrHttp {
  return new VultrHttp({ apiKey: key, gate, fetchImpl, maxRps: 10 });
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const CTX = { session_id: 'verifier' };

/** Read raw so `os` and `power_status` are visible; a second page is an error, never a silently short list. */
async function listInstances(http: VultrHttp): Promise<LiveResource[]> {
  const res = await http.request<{ instances?: Raw[]; meta?: { links?: { next?: string } } }>('GET', '/instances', { ...CTX, query: { per_page: 500 } });
  if (res.meta?.links?.next) throw new Error('LIST_TRUNCATED: more than 500 instances');
  return (res.instances ?? []).map((i) => ({
    id: str(i.id), class: 'instance' as const, label: str(i.label), status: str(i.status), power_status: str(i.power_status),
    plan: str(i.plan), region: str(i.region), os: str(i.os),
  }));
}

export async function snapshot(http: VultrHttp, clock: () => number = Date.now): Promise<Snapshot> {
  const at = clock();
  try {
    const [inst, vpcs, regs] = await Promise.all([listInstances(http), new Vpcs(http).list(CTX), new Registries(http).list(CTX)]);
    const live: LiveResource[] = [
      ...inst,
      ...vpcs.map((v) => ({ id: v.id, class: 'vpc' as const, label: v.description, status: 'active', power_status: '', plan: '', region: v.region, os: '' })),
      ...regs.map((r) => ({ id: r.id, class: 'registry' as const, label: r.name, status: 'active', power_status: '', plan: 'start_up', region: r.region, os: '' })),
    ];
    return { ok: true, at, live };
  } catch (e) {
    return { ok: false, at, error: String((e as Error).message).slice(0, 120) };
  }
}

/** AG4-VER-7: the verifier key may carry the observer-tier ACL (and billing at most); the string lives only in the adapter */
export const VIEW_ONLY_ACLS: readonly string[] = [TIER_ACL.observer, 'billing'];

/**
 * AG4-VER-7: read the key's ACLs from GET /account and refuse to boot (fail closed) when the key is over-scoped, has no view ACL,
 * or its ACLs cannot be read at all. Only a GET, so the verifier never needs a write path to prove it has none.
 */
export async function assertViewOnlyKey(http: VultrHttp): Promise<string[]> {
  let acls: string[];
  try {
    const res = await http.request<{ account?: { acls?: unknown } }>('GET', '/account', CTX);
    const raw = res?.account?.acls;
    if (!Array.isArray(raw)) throw new Error('response carries no acls array');
    acls = raw.map(String);
  } catch (e) {
    throw new Error(`BOOT_REFUSED: cannot read the verifier key's ACLs (fail closed): ${String((e as Error).message).slice(0, 100)}`);
  }
  const extra = acls.filter((a) => !VIEW_ONLY_ACLS.includes(a));
  if (extra.length > 0) throw new Error(`BOOT_REFUSED: the verifier key is over-scoped, extra ACLs: ${extra.join(',')}`);
  if (!acls.includes(TIER_ACL.observer)) throw new Error(`BOOT_REFUSED: the verifier key lacks ${TIER_ACL.observer}`);
  return acls;
}
