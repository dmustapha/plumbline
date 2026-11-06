// File: packages/vultr-adapter/src/http.ts
import type { SpendGate, SpendKind } from '@plumbline/ledger';

export const VULTR_BASE = 'https://api.vultr.com/v2';

export class VultrError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterS: number | null,
    readonly path: string,
  ) {
    super(`vultr ${status} on ${path}`);
  }
  get isIpLocked(): boolean {
    return this.status === 401;
  }
  get isPermission(): boolean {
    return this.status === 403;
  }
}

/** A mutating call whose result we never saw (timeout/network/unparseable) after it may have been accepted. Reconcile must see it. */
export class OutcomeUnknown extends Error {
  constructor(
    readonly request_id: string,
    readonly method: string,
    readonly path: string,
    readonly session_id: string,
    readonly cause_message: string,
    readonly estimate_usd: number,
  ) {
    super(`outcome unknown: ${method} ${path} (request ${request_id}): ${cause_message}`);
  }
}

export class SpendRefused extends Error {
  constructor(readonly reason: string) {
    super(`spend refused: ${reason}`);
  }
}

const SECRET_KEYS = new Set(['default_password', 'api_key', 'access_key', 'secret_key', 'password']);

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.has(k) ? '[redacted]' : redact(v);
    return out as T;
  }
  return value;
}

export interface HttpOptions {
  apiKey: string | null;
  gate: SpendGate;
  baseUrl?: string;
  /** capped at SHARED_MAX_RPS: the budget is process-wide, never per instance (AG4-ADP-4) */
  maxRps?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** AG4-ADP-8: every VultrError (incl. 401) is reported so TierKeys can mark the tier down */
  onFailure?: (e: VultrError) => void;
  /** AG4-ADP-5: a mutation with an unknown outcome is reported here so the broker can record it for reconcile */
  onUnknown?: (u: OutcomeUnknown) => void;
}

export interface CallOptions {
  session_id: string;
  body?: unknown;
  query?: Record<string, string | number>;
  costUsd?: number;
  kind?: SpendKind;
  /** the engine request id; identifies an UNKNOWN outcome for reconcile */
  request_id?: string;
}

/** One egress IP, one 30 req/s Vultr limit (KP-P6): a single module-level slot clock shared by every VultrHttp. */
export const SHARED_MAX_RPS = 20;
const SPACING_MS = 1000 / SHARED_MAX_RPS;
const shared = { nextSlot: 0 };

export function resetSharedLimiter(): void {
  shared.nextSlot = 0;
}

async function takeSlot(sleep: (ms: number) => Promise<void>): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, shared.nextSlot);
  shared.nextSlot = at + SPACING_MS;
  if (at > now) await sleep(at - now);
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export class VultrHttp {
  readonly #apiKey: string | null;
  readonly #gate: SpendGate;
  readonly #base: string;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeout: number;
  readonly #onFailure: ((e: VultrError) => void) | undefined;
  readonly #onUnknown: ((u: OutcomeUnknown) => void) | undefined;

  constructor(o: HttpOptions) {
    this.#apiKey = o.apiKey;
    this.#gate = o.gate;
    this.#base = o.baseUrl ?? VULTR_BASE;
    this.#maxRetries = o.maxRetries ?? 4;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#timeout = o.timeoutMs ?? 15000;
    this.#onFailure = o.onFailure;
    this.#onUnknown = o.onUnknown;
  }

  toJSON(): string {
    return '[VultrHttp]';
  }

  /** The body is returned exactly as Vultr sent it (issueKey needs the real api_key); redact() is for logs and errors only. */
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, o: CallOptions): Promise<T> {
    const cost = o.costUsd ?? 0;
    const charge = this.#gate.charge(o.kind ?? 'vultr', cost, { session_id: o.session_id });
    if (!charge.ok) throw new SpendRefused(charge.reason);
    let settleWith = 0;
    try {
      const out = await this.#send<T>(method, path, o);
      settleWith = cost;
      return out;
    } catch (e) {
      if (e instanceof VultrError) this.#onFailure?.(e);
      const ambiguous = e instanceof VultrError ? e.status >= 500 : e instanceof Error;
      if (method === 'GET' || !ambiguous) throw e;
      settleWith = cost; // the provider may have accepted it: keep the cost reserved, never undercount spend
      const unknown = new OutcomeUnknown(o.request_id ?? 'unknown', method, path, o.session_id, errText(e), cost);
      this.#onUnknown?.(unknown);
      throw unknown;
    } finally {
      charge.receipt.settle(settleWith);
    }
  }

  async #send<T>(method: string, path: string, o: CallOptions): Promise<T> {
    const qs = o.query ? '?' + new URLSearchParams(Object.entries(o.query).map(([k, v]) => [k, String(v)])).toString() : '';
    const url = `${this.#base}${path}${qs}`;
    for (let attempt = 0; ; attempt += 1) {
      await takeSlot(this.#sleep);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await this.#fetch(url, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: AbortSignal.timeout(this.#timeout) });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (res.ok) {
        return parsed as T;
      }
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      const retryable = res.status === 429 || (res.status >= 500 && method === 'GET');
      if (!retryable || attempt >= this.#maxRetries) throw new VultrError(res.status, redact(parsed), retryAfter, path);
      await this.#sleep(retryAfter ? retryAfter * 1000 : Math.min(8000, 400 * 2 ** attempt));
    }
  }
}
