// File: apps/range-api/src/sessionBook.ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface Entry {
  keyHash: Buffer;
  ip: string;
  at: number;
  /** SEC-H1: time of the last attack; env-proof and reads never move it. */
  lastAttack: number;
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
  /**
   * ttlMs: how long an entry is remembered (spend accounting per IP outlives the credential).
   * lifetimeMs: SEC-H1, the total life of a session's credential. Past it the session is unknown to every route, so activity
   * cannot keep a session (and its broker-side playground) alive for ever.
   */
  constructor(private readonly ttlMs: number = 3 * 60 * 60_000, private readonly clock: () => number = Date.now, private readonly lifetimeMs: number = 60 * 60_000) {}

  static isSessionId(v: unknown): v is string {
    return typeof v === 'string' && SESSION_ID.test(v);
  }

  /** Returns the secret key (shown once) and the ids dropped because they outlived the ttl. */
  register(sid: string, ip: string): { key: string; expired: string[] } {
    const expired = this.#prune();
    const key = randomBytes(16).toString('hex');
    this.#entries.set(sid, { keyHash: hashOf(key), ip, at: this.clock(), lastAttack: this.clock() });
    return { key, expired };
  }

  #usable(sid: unknown): Entry | undefined {
    const e = typeof sid === 'string' ? this.#entries.get(sid) : undefined;
    return e && this.clock() - e.at < this.lifetimeMs ? e : undefined;
  }

  has(sid: string): boolean {
    return this.#usable(sid) !== undefined;
  }

  /** Records an attack: the session counts as live for another idle window. */
  touch(sid: string): void {
    const e = this.#entries.get(sid);
    if (e) e.lastAttack = this.clock();
  }

  /** SEC-H1: sessions of this address that are inside their lifetime and had an attack (or were created) within idleMs. */
  liveSessionsOf(ip: string, idleMs: number): string[] {
    const now = this.clock();
    return [...this.#entries].filter(([sid, e]) => e.ip === ip && this.#usable(sid) !== undefined && now - e.lastAttack < idleMs).map(([sid]) => sid);
  }

  check(sid: unknown, key: unknown): KeyCheck {
    if (typeof key !== 'string' || key.length === 0) return 'KEY_REQUIRED';
    const e = this.#usable(sid);
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
