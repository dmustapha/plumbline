// File: apps/broker/src/tokens.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TaskClaims {
  task_id: string;
  session_id: string;
  exp: number;
  epoch: number;
}

const b64 = (b: Buffer): string => b.toString('base64url');

export class TokenService {
  #epoch = 0;
  constructor(private readonly secret: string, private readonly clock: () => number = Date.now) {}

  revokeAll(): void {
    this.#epoch += 1;
  }

  mint(task_id: string, session_id: string, ttlMs = 120_000): { token: string; exp: number } {
    const claims: TaskClaims = { task_id, session_id, exp: this.clock() + ttlMs, epoch: this.#epoch };
    const payload = b64(Buffer.from(JSON.stringify(claims)));
    const sig = b64(createHmac('sha256', this.secret).update(payload).digest());
    return { token: `plbt.${payload}.${sig}`, exp: claims.exp };
  }

  verify(token: string | undefined): TaskClaims | null {
    if (!token || !token.startsWith('plbt.')) return null;
    const [, payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = createHmac('sha256', this.secret).update(payload).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TaskClaims;
      if (claims.exp < this.clock() || claims.epoch !== this.#epoch) return null;
      return claims;
    } catch {
      return null;
    }
  }
}
