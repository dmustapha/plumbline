// File: apps/broker/src/sessions.ts
import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  created_at: number;
  last_seen: number;
  tier: 'observer' | 'standard';
  playground: { id: string; label: string } | null;
}

/**
 * CO-A (E-2): the playground VPC subnet is derived from the session id, so it is deterministic and needs no state.
 * First octet 100..199 stays clear of the baseline/gate VPCs (10.9, 10.88) and Vultr's default 10.x ranges.
 */
export function playgroundSubnet(sid: string): string {
  const b = Buffer.from(sid, 'hex');
  return `10.${100 + (b[0] ?? 0) % 100}.${b[1] ?? 0}.0`;
}

export const PLAYGROUND_SUBNET_SIZE = 24;

export class SessionRegistry {
  readonly #sessions = new Map<string, Session>();
  constructor(private readonly clock: () => number = Date.now) {}

  create(): Session {
    // 8 lowercase hex characters: the floor's playground label rule is plumbline-s<8 hex>-<name> (PLAYGROUND_LABEL_RE).
    // The id must also map to a subnet no live session holds (two ids can share the 16 bits the subnet uses).
    const taken = new Set([...this.#sessions.keys()].map(playgroundSubnet));
    let id = randomBytes(4).toString('hex');
    while (this.#sessions.has(id) || taken.has(playgroundSubnet(id))) id = randomBytes(4).toString('hex');
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
