// File: apps/range-api/src/config.ts
export interface ApiConfig {
  host: string;
  port: number;
  brokerSocket: string;
  runnerSocket: string;
  apiToken: string;
  runnerToken: string;
  verifierUrl: string | null;
  evidenceDir: string;
  publicDir: string;
  keyExpiryIso: string | null;
  demoCaps: boolean;
  maxInFlight: number;
  /** AG4-PRD-5: session creations allowed per IP in `sessionWindowMs`. Each session creates a real playground resource. */
  sessionsPerIp: number;
  sessionWindowMs: number;
  /** AG4-PRD-5: session creations per minute across all callers. */
  sessionsPerMinute: number;
  /** AG4-PRD-5: no new session while the broker already holds this many. */
  maxSessions: number;
  /** AG4-PRD-5: spend ceiling per IP across ALL its sessions (a new session never resets it). */
  ipSpendCapUsd: number;
  /** SEC-H1: live sessions one address may hold at once. */
  liveSessionsPerIp: number;
  /** SEC-H1: a session with no attack for this long no longer counts as live (matches the broker idle limit). */
  liveIdleMs: number;
  /** SEC-M3: open SSE streams per address and in total. */
  maxStreamsPerIp: number;
  maxStreams: number;
}

type Env = Record<string, string | undefined>;

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`BOOT_REFUSED: missing ${name}`);
  return v;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`BOOT_REFUSED: ${name} must be a positive number`);
  return n;
}

export function loadApiConfig(env: Env): ApiConfig {
  for (const forbidden of ['VULTR_API_KEY', 'VULTR_INFERENCE_API_KEY', 'VULTR_S3_SECRET_KEY', 'VULTR_S3_ACCESS_KEY', 'VULTR_KEY_DEPLOYER']) {
    if (env[forbidden]) throw new Error(`BOOT_REFUSED: ${forbidden} must not be present in the range API environment`);
  }
  return {
    host: env.PLUMBLINE_API_HOST ?? '127.0.0.1',
    port: Number(env.PLUMBLINE_API_PORT ?? 8080),
    brokerSocket: env.PLUMBLINE_SOCKET ?? '/run/plumbline/broker.sock',
    runnerSocket: env.PLUMBLINE_RUNNER_SOCKET ?? '/run/plumbline/runner.sock',
    apiToken: need(env, 'PLUMBLINE_API_TOKEN'),
    runnerToken: need(env, 'PLUMBLINE_RUNNER_TOKEN'),
    verifierUrl: env.PLUMBLINE_VERIFIER_URL ?? null,
    evidenceDir: env.PLUMBLINE_EVIDENCE_DIR ?? '/opt/plumbline/app/evidence',
    publicDir: env.PLUMBLINE_PUBLIC_DIR ?? '/opt/plumbline/app/apps/range-api/public',
    keyExpiryIso: env.PLUMBLINE_KEY_EXPIRY_ISO ?? null,
    demoCaps: env.PLUMBLINE_DEMO_CAPS === '1',
    maxInFlight: Number(env.PLUMBLINE_MAX_IN_FLIGHT ?? 4),
    sessionsPerIp: positive(env, 'PLUMBLINE_SESSIONS_PER_IP', 3),
    sessionWindowMs: positive(env, 'PLUMBLINE_SESSION_WINDOW_MS', 600_000),
    sessionsPerMinute: positive(env, 'PLUMBLINE_SESSIONS_PER_MINUTE', 10),
    maxSessions: positive(env, 'PLUMBLINE_MAX_SESSIONS', 20),
    ipSpendCapUsd: positive(env, 'PLUMBLINE_IP_SPEND_CAP_USD', 1.5),
    liveSessionsPerIp: positive(env, 'PLUMBLINE_LIVE_SESSIONS_PER_IP', 2),
    liveIdleMs: positive(env, 'PLUMBLINE_LIVE_IDLE_MS', 600_000),
    maxStreamsPerIp: positive(env, 'PLUMBLINE_MAX_STREAMS_PER_IP', 3),
    maxStreams: positive(env, 'PLUMBLINE_MAX_STREAMS', 200),
  };
}
