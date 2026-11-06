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
