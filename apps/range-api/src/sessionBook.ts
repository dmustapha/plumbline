// File: apps/range-api/src/sessionBook.ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface Entry {
  keyHash: Buffer;
  ip: string;
  at: number;
}

export type KeyCheck = 'OK' | 'KEY_REQUIRED' | 'SESSION_UNKNOWN' | 'KEY_MISMATCH';

const SESSION_ID = /^[0-9a-f]{8}$/;
const hashOf = (key: string): Buffer => createHash('sha256').update(key).digest();

/**
 * Binds a session id to the caller that created it (AG4-PRD-6, AG4-BRK-3). Session ids appear in public decision rows
 * (/replay), so an id alone is not a credential: every mutating route also needs the session key returned once at creation.
 * Also remembers which IP created which session so spend can be tied per IP (AG4-PRD-5).
 */
export class SessionBook {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly ttlMs: number = 3 * 60 * 60_000, private readonly clock: () => number = Date.now) {}

  static isSessionId(v: unknown): v is string {
    return typeof v === 'string' && SESSION_ID.test(v);
  }

  /** Returns the secret key (shown once) and the ids dropped because they outlived the ttl. */
  register(sid: string, ip: string): { key: string; expired: string[] } {
    const expired = this.#prune();
    const key = randomBytes(16).toString('hex');
    this.#entries.set(sid, { keyHash: hashOf(key), ip, at: this.clock() });
    return { key, expired };
  }

  has(sid: string): boolean {
    return this.#entries.has(sid);
  }

  check(sid: unknown, key: unknown): KeyCheck {
    if (typeof key !== 'string' || key.length === 0) return 'KEY_REQUIRED';
    const e = typeof sid === 'string' ? this.#entries.get(sid) : undefined;
    if (!e) return 'SESSION_UNKNOWN';
    return timingSafeEqual(e.keyHash, hashOf(key)) ? 'OK' : 'KEY_MISMATCH';
  }

  sessionsOf(ip: string): string[] {
    return [...this.#entries].filter(([, e]) => e.ip === ip).map(([sid]) => sid);
  }

  #prune(): string[] {
    const cutoff = this.clock() - this.ttlMs;
    const gone = [...this.#entries].filter(([, e]) => e.at < cutoff).map(([sid]) => sid);
    for (const sid of gone) this.#entries.delete(sid);
    return gone;
  }
}
