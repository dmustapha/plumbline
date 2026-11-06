// File: apps/broker/src/lease.ts
import { createHmac, randomBytes } from 'node:crypto';

export function leaseSignature(secret: string, ts: number, nonce: string, ttlS: number): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${ttlS}`).digest('hex');
}

export class LeaseEmitter {
  #timer: NodeJS.Timeout | null = null;
  #lastOk = 0;
  #lastError = '';
  #ttlS: number;

  constructor(
    private readonly url: string | null,
    private readonly secret: string,
    ttlS: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.#ttlS = ttlS;
  }

  start(intervalMs = 5000): void {
    if (!this.url || this.#timer) return;
    void this.beat();
    this.#timer = setInterval(() => void this.beat(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  setTtl(ttlS: number): void {
    this.#ttlS = ttlS;
  }

  async beat(): Promise<boolean> {
    if (!this.url) return false;
    const ts = this.clock();
    const nonce = randomBytes(8).toString('hex');
    try {
      const res = await this.fetchImpl(`${this.url}/lease/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-plumbline-sig': leaseSignature(this.secret, ts, nonce, this.#ttlS) },
        body: JSON.stringify({ ts, nonce, ttl_s: this.#ttlS }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) this.#lastOk = ts;
      else this.#lastError = `HTTP ${res.status}`;
      return res.ok;
    } catch (e) {
      this.#lastError = String((e as Error).message);
      return false;
    }
  }

  async expireNow(): Promise<boolean> {
    const keep = this.#ttlS;
    this.#ttlS = 0;
    const ok = await this.beat();
    this.#ttlS = keep;
    return ok;
  }

  status(): { configured: boolean; last_ok_ms: number; last_error: string; ttl_s: number } {
    return { configured: this.url !== null, last_ok_ms: this.#lastOk, last_error: this.#lastError, ttl_s: this.#ttlS };
  }
}
