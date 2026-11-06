// File: apps/verifier/src/config.ts
// D-R6a: two processes, two env files. Each loader refuses the OTHER process's key, so a mis-edited env file fails at boot
// instead of giving the verifier create power. The watchdog half is owned by stream G1c (see the watchdog config at the end).
type Env = Record<string, string | undefined>;

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`BOOT_REFUSED: missing ${name}`);
  return v;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`BOOT_REFUSED: ${name} must be an integer in ${min}..${max}`);
  return n;
}

/** Never poll faster than 3 s (DT-8: a created-then-destroyed instance needs two polls to be seen) */
export const MIN_POLL_GAP_MS = 3000;
export const LEASE_MAX_TTL_CEILING_S = 120;

export interface VerifierConfig {
  host: string;
  port: number;
  viewKey: string;
  leaseSecret: string;
  brokerPublicUrl: string;
  ledgerExportPath: string;
  sharedDir: string;
  stateDir: string;
  baselinePath: string;
  pollGapMs: number;
  floorPath: string;
  floorSigPath: string;
  policyPubkeyB64: string | null;
  leaseMaxTtlS: number;
  exportMaxAgeMs: number;
  watchdogUid: number | null;
}

export function loadVerifierConfig(env: Env): VerifierConfig {
  if (env.PLUMBLINE_WATCHDOG_KEY || env.VULTR_API_KEY) throw new Error('BOOT_REFUSED: the verifier must not hold the watchdog key or the owner key');
  const uid = env.PLUMBLINE_WATCHDOG_UID;
  return {
    host: env.PLUMBLINE_VERIFIER_HOST ?? '127.0.0.1',
    port: int(env, 'PLUMBLINE_VERIFIER_PORT', 8081, 1, 65535),
    viewKey: need(env, 'PLUMBLINE_VERIFIER_KEY'),
    leaseSecret: need(env, 'PLUMBLINE_LEASE_SECRET'),
    brokerPublicUrl: need(env, 'PLUMBLINE_BROKER_PUBLIC_URL').replace(/\/+$/, ''),
    ledgerExportPath: env.PLUMBLINE_LEDGER_EXPORT_PATH ?? '/v1/ledger/export',
    sharedDir: env.PLUMBLINE_SHARED_DIR ?? '/var/lib/plumbline-shared',
    stateDir: env.PLUMBLINE_STATE_DIR ?? '/var/lib/plumbline-verifier',
    baselinePath: env.PLUMBLINE_BASELINE_PATH ?? '/etc/plumbline/baseline.json',
    pollGapMs: int(env, 'PLUMBLINE_POLL_GAP_MS', MIN_POLL_GAP_MS, MIN_POLL_GAP_MS, 60_000),
    floorPath: env.PLUMBLINE_FLOOR_PATH ?? '/opt/plumbline/app/policy/floor.yaml',
    floorSigPath: env.PLUMBLINE_FLOOR_SIG_PATH ?? '/opt/plumbline/app/policy/floor.yaml.sig',
    policyPubkeyB64: env.PLUMBLINE_POLICY_PUBKEY || null,
    leaseMaxTtlS: int(env, 'PLUMBLINE_LEASE_MAX_TTL_S', LEASE_MAX_TTL_CEILING_S, 1, LEASE_MAX_TTL_CEILING_S),
    exportMaxAgeMs: int(env, 'PLUMBLINE_EXPORT_MAX_AGE_S', 60, 5, 600) * 1000,
    watchdogUid: uid === undefined || uid === '' ? null : int(env, 'PLUMBLINE_WATCHDOG_UID', 0, 0, 4_294_967_295),
  };
}

/** Watchdog half: consumed by stream G1c (watchdog.ts, main-watchdog.ts). Verbatim from ARCHITECTURE plus the two lease-reader knobs of F5 section 1. */
export interface WatchdogConfig {
  deleteKey: string;
  sharedDir: string;
  floorPath: string;
  floorSigPath: string;
  policyPubkeyB64: string;
  dryRun: boolean;
  tickMs: number;
  /** uid of the verifier user: lease.json must be owned by it (readLease opts.uid) */
  verifierUid: number | null;
  /** first-contact grace before a missing lease file counts as LAPSED (AG4-VER-3) */
  leaseGraceMs: number;
}

export function loadWatchdogConfig(env: Env): WatchdogConfig {
  if (env.PLUMBLINE_VERIFIER_KEY || env.PLUMBLINE_LEASE_SECRET || env.VULTR_API_KEY) throw new Error('BOOT_REFUSED: the watchdog must not hold the verifier key, the lease secret or the owner key');
  const uid = env.PLUMBLINE_VERIFIER_UID;
  return {
    deleteKey: need(env, 'PLUMBLINE_WATCHDOG_KEY'),
    sharedDir: env.PLUMBLINE_SHARED_DIR ?? '/var/lib/plumbline-shared',
    floorPath: env.PLUMBLINE_FLOOR_PATH ?? '/opt/plumbline/app/policy/floor.yaml',
    floorSigPath: env.PLUMBLINE_FLOOR_SIG_PATH ?? '/opt/plumbline/app/policy/floor.yaml.sig',
    policyPubkeyB64: need(env, 'PLUMBLINE_POLICY_PUBKEY'),
    dryRun: env.PLUMBLINE_WATCHDOG_DRY_RUN === '1',
    tickMs: Number(env.PLUMBLINE_WATCHDOG_TICK_MS ?? 2000),
    verifierUid: uid === undefined || uid === '' ? null : int(env, 'PLUMBLINE_VERIFIER_UID', 0, 0, 4_294_967_295),
    leaseGraceMs: int(env, 'PLUMBLINE_LEASE_GRACE_S', 120, 10, 900) * 1000,
  };
}
