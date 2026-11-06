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
  maxRps?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface CallOptions {
  session_id: string;
  body?: unknown;
  query?: Record<string, string | number>;
  costUsd?: number;
  kind?: SpendKind;
}

export class VultrHttp {
  readonly #apiKey: string | null;
  readonly #gate: SpendGate;
  readonly #base: string;
  readonly #spacingMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeout: number;
  #nextSlot = 0;

  constructor(o: HttpOptions) {
    this.#apiKey = o.apiKey;
    this.#gate = o.gate;
    this.#base = o.baseUrl ?? VULTR_BASE;
    this.#spacingMs = 1000 / Math.min(o.maxRps ?? 20, 25);
    this.#maxRetries = o.maxRetries ?? 4;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#timeout = o.timeoutMs ?? 15000;
  }

  toJSON(): string {
    return '[VultrHttp]';
  }

  async #slot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextSlot);
    this.#nextSlot = at + this.#spacingMs;
    if (at > now) await this.#sleep(at - now);
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, o: CallOptions): Promise<T> {
    const charge = this.#gate.charge(o.kind ?? 'vultr', o.costUsd ?? 0, { session_id: o.session_id });
    if (!charge.ok) throw new SpendRefused(charge.reason);
    const qs = o.query ? '?' + new URLSearchParams(Object.entries(o.query).map(([k, v]) => [k, String(v)])).toString() : '';
    const url = `${this.#base}${path}${qs}`;
    let attempt = 0;
    for (;;) {
      await this.#slot();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await this.#fetch(url, {
        method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: AbortSignal.timeout(this.#timeout),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (res.ok) {
        charge.receipt.settle(o.costUsd ?? 0);
        return redact(parsed) as T;
      }
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      const retryable = res.status === 429 || (res.status >= 500 && method === 'GET');
      if (retryable && attempt < this.#maxRetries) {
        const wait = retryAfter ? retryAfter * 1000 : Math.min(8000, 400 * 2 ** attempt);
        attempt += 1;
        await this.#sleep(wait);
        continue;
      }
      charge.receipt.settle(0);
      throw new VultrError(res.status, redact(parsed), retryAfter, path);
    }
  }
}
