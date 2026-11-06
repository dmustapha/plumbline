// File: apps/broker/src/sessions.ts
import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  created_at: number;
  last_seen: number;
  tier: 'observer' | 'standard';
  playground: { id: string; label: string } | null;
}

export class SessionRegistry {
  readonly #sessions = new Map<string, Session>();
  constructor(private readonly clock: () => number = Date.now) {}

  create(): Session {
    const id = randomBytes(8).toString('hex').slice(0, 12);
    const s: Session = { id, created_at: this.clock(), last_seen: this.clock(), tier: 'standard', playground: null };
    this.#sessions.set(id, s);
    return s;
  }

  get(id: string): Session | undefined {
    const s = this.#sessions.get(id);
    if (s) s.last_seen = this.clock();
    return s;
  }

  tier(id: string): 'observer' | 'standard' {
    return this.#sessions.get(id)?.tier ?? 'standard';
  }

  setTier(id: string, tier: 'observer' | 'standard'): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    s.tier = tier;
    return true;
  }

  expired(idleMs: number): Session[] {
    return [...this.#sessions.values()].filter((s) => this.clock() - s.last_seen > idleMs);
  }

  drop(id: string): void {
    this.#sessions.delete(id);
  }

  count(): number {
    return this.#sessions.size;
  }
}
