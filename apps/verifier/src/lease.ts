// File: apps/verifier/src/lease.ts
// PRD C9 Lease {last_renew_ts, ttl_s}. The verifier process receives signed heartbeats from the broker and writes lease.json into the
// shared directory; the watchdog (a different Unix user) only READS it through readLease/leaseState below and holds no secret.
// AG4-VER-2: ttl_s is bounded.  AG4-VER-3: a missing or unreadable lease fails CLOSED after a first-contact grace.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LeaseFile {
  last_ts: number;
  ttl_s: number;
  received_at: number;
}

export type LeaseState = 'NEVER' | 'ALIVE' | 'LAPSED';

/** Hard bound a reader accepts in a lease file, whatever the receiver's own (lower) configured maximum */
export const LEASE_FILE_MAX_TTL_S = 300;
export const DEFAULT_LEASE_MAX_TTL_S = 120;
export const DEFAULT_GRACE_MS = 120_000;
const SKEW_MS = 30_000;
const FUTURE_SLACK_MS = 5000;
const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;

export function leaseSignature(secret: string, ts: number, nonce: string, ttlS: number): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${ttlS}`).digest('hex');
}

/**
 * AG4-VER-3: the shared dir is group-shared between the verifier and the watchdog. It must not be world-accessible, and when it is
 * group-writable it must be sticky (1770) so the watchdog user cannot replace or delete lease.json. Throws BOOT_REFUSED.
 */
export function assertSharedDir(dir: string): void {
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`BOOT_REFUSED: shared dir ${dir} is not a directory`);
  if ((st.mode & 0o007) !== 0) throw new Error(`BOOT_REFUSED: shared dir ${dir} is world-accessible (mode ${(st.mode & 0o7777).toString(8)})`);
  if ((st.mode & 0o020) !== 0 && (st.mode & 0o1000) === 0) throw new Error(`BOOT_REFUSED: shared dir ${dir} is group-writable without the sticky bit`);
}

export class LeaseReceiver {
  readonly #seen = new Set<string>();
  #lastTs = 0;

  constructor(
    private readonly secret: string,
    private readonly dir: string,
    private readonly clock: () => number = Date.now,
    private readonly maxTtlS: number = DEFAULT_LEASE_MAX_TTL_S,
  ) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o1770);
    }
    assertSharedDir(dir);
    this.#lastTs = readLease(dir)?.last_ts ?? 0;
  }

  accept(body: { ts: number; nonce: string; ttl_s: number }, sigHex: string | undefined): { ok: boolean; why?: string } {
    if (!sigHex || !validBody(body)) return { ok: false, why: 'malformed' };
    if (Math.abs(this.clock() - body.ts) > SKEW_MS) return { ok: false, why: 'skew' };
    const want = Buffer.from(leaseSignature(this.secret, body.ts, body.nonce, body.ttl_s));
    const got = Buffer.from(sigHex);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: 'signature' };
    if (body.ttl_s > this.maxTtlS) return { ok: false, why: 'ttl-too-large' };
    if (this.#seen.has(body.nonce)) return { ok: false, why: 'replay' };
    if (body.ts <= this.#lastTs) return { ok: false, why: 'stale-ts' };
    this.#seen.add(body.nonce);
    if (this.#seen.size > 5000) this.#seen.clear();
    this.#lastTs = body.ts;
    this.#write({ last_ts: body.ts, ttl_s: body.ttl_s, received_at: this.clock() });
    return { ok: true };
  }

  #write(file: LeaseFile): void {
    const tmp = join(this.dir, 'lease.json.tmp');
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o640 });
    chmodSync(tmp, 0o640);
    renameSync(tmp, join(this.dir, 'lease.json'));
  }
}

function validBody(b: { ts: number; nonce: string; ttl_s: number } | undefined): b is { ts: number; nonce: string; ttl_s: number } {
  return typeof b?.ts === 'number' && Number.isFinite(b.ts) && typeof b.nonce === 'string' && NONCE_RE.test(b.nonce)
    && typeof b.ttl_s === 'number' && Number.isInteger(b.ttl_s) && b.ttl_s >= 0;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Null for a missing, unparseable, mistyped, over-bound, symlinked, writable-by-others or wrongly owned file. Never throws. */
export function readLease(dir: string, opts: { uid?: number } = {}): LeaseFile | null {
  const file = join(dir, 'lease.json');
  try {
    const st = lstatSync(file);
    if (!st.isFile() || (st.mode & 0o022) !== 0) return null;
    if (opts.uid !== undefined && st.uid !== opts.uid) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LeaseFile>;
    if (!isNum(raw.last_ts) || !isNum(raw.ttl_s) || !isNum(raw.received_at)) return null;
    if (raw.ttl_s < 0 || raw.ttl_s > LEASE_FILE_MAX_TTL_S) return null;
    return { last_ts: raw.last_ts, ttl_s: raw.ttl_s, received_at: raw.received_at };
  } catch {
    return null;
  }
}

export interface LeaseContext {
  /** when the reading process started: the first-contact grace runs from here */
  startedAt: number;
  graceMs?: number;
  /** true once the caller has ever read an ALIVE lease: a vanished file is then LAPSED at once */
  everSeen?: boolean;
  /**
   * M1: the grace also covers a PRESENT but stale file (lease.json survives a VM reboot, the broker is about to renew it). Opt-in so a
   * caller that is not a fresh process keeps the strict behaviour. A ttl<=0 kill-switch lease and a future-dated file are never excused.
   */
  graceStale?: boolean;
}

export function leaseState(l: LeaseFile | null, now: number, ctx?: LeaseContext): LeaseState {
  const inGrace = ctx !== undefined && ctx.everSeen !== true && now - ctx.startedAt <= (ctx.graceMs ?? DEFAULT_GRACE_MS);
  if (!l) return inGrace ? 'NEVER' : 'LAPSED';
  if (l.ttl_s <= 0 || l.received_at - now > FUTURE_SLACK_MS) return 'LAPSED';
  if (now - l.received_at <= l.ttl_s * 1000) return 'ALIVE';
  return inGrace && ctx?.graceStale === true ? 'NEVER' : 'LAPSED';
}
