// File: apps/range-api/src/rateLimit.ts
export class SlidingWindow {
  readonly #hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: () => number = Date.now) {}

  take(key: string): { ok: true } | { ok: false; retryAfterS: number } {
    const now = this.clock();
    const live = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (live.length >= this.limit) {
      this.#hits.set(key, live);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((live[0] as number + this.windowMs - now) / 1000)) };
    }
    live.push(now);
    this.#hits.set(key, live);
    return { ok: true };
  }
}

export class InFlight {
  #n = 0;
  constructor(private readonly max: number) {}
  tryEnter(): boolean {
    if (this.#n >= this.max) return false;
    this.#n += 1;
    return true;
  }
  leave(): void {
    this.#n = Math.max(0, this.#n - 1);
  }
  get count(): number {
    return this.#n;
  }
}

/**
 * SEC-H3: one in-flight or recent answer per key. Concurrent callers share the same promise; a settled answer is reused for ttlMs.
 * A rejected promise is never kept, so a broker hiccup is not cached.
 */
export class Coalescer<T> {
  readonly #entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private readonly ttlMs: number, private readonly clock: () => number = Date.now) {}

  get(key: string, make: () => Promise<T>): Promise<T> {
    const now = this.clock();
    for (const [k, e] of this.#entries) if (now - e.at >= this.ttlMs) this.#entries.delete(k);
    const have = this.#entries.get(key);
    if (have) return have.value;
    const value = make();
    this.#entries.set(key, { at: now, value });
    value.catch(() => { if (this.#entries.get(key)?.value === value) this.#entries.delete(key); });
    return value;
  }

  size(): number {
    return this.#entries.size;
  }
}

/** SEC-M3: caps open SSE streams per client address and in total. Every successful open must be paired with one close. */
export class StreamGate {
  readonly #perIp = new Map<string, number>();
  #total = 0;
  constructor(private readonly maxPerIp: number, private readonly maxTotal: number) {}

  /** Returns a close function, or null when the caller or the server is at its cap. */
  open(ip: string): (() => void) | null {
    const mine = this.#perIp.get(ip) ?? 0;
    if (mine >= this.maxPerIp || this.#total >= this.maxTotal) return null;
    this.#perIp.set(ip, mine + 1);
    this.#total += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.#total -= 1;
      const left = (this.#perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.#perIp.delete(ip);
      else this.#perIp.set(ip, left);
    };
  }

  get count(): number {
    return this.#total;
  }
}
