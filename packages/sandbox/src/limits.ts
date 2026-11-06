export interface Limits {
  mem_mb: number;
  cpus: number;
  pids: number;
  wall_s: number;
}

export type SandboxState =
  | 'OK' | 'ERROR' | 'SANDBOX_TIMEOUT' | 'SANDBOX_OOM' | 'SANDBOX_PIDS' | 'SANDBOX_STUCK';

export const DEFAULT_LIMITS: Limits = { mem_mb: 128, cpus: 0.5, pids: 64, wall_s: 30 };
export const DEMO_LIMITS: Limits = { ...DEFAULT_LIMITS, wall_s: 10 };
export const MAX_LIMITS: Limits = { mem_mb: 256, cpus: 1, pids: 128, wall_s: 30 };
/** AG4-SBX-8: a caller can lower limits, but not below what the interpreter needs to start (tiny values reached docker). */
export const MIN_LIMITS: Limits = { mem_mb: 64, cpus: 0.1, pids: 16, wall_s: 1 };

export const SANDBOX_NETWORK = 'plb-sbx-net';
export const SANDBOX_BRIDGE = 'br-plb';
export const SANDBOX_SUBNET = '172.28.0.0/24';
export const SANDBOX_GATEWAY = '172.28.0.1';
export const GATE_NAME = 'plb-gate';
/** AG4-SBX-3: the relay has a fixed address so the harness can whitelist exactly one ip:port (not the subnet). */
export const GATE_IP = '172.28.0.2';
export const GATE_PORT = 8080;
export const SANDBOX_IMAGE = 'plumbline-sandbox:1';
export const SANDBOX_LABEL = 'plumbline-sbx';
/** Where the U-4 fallback socket appears inside the container (dedicated sandbox listener, never the admin socket). */
export const SANDBOX_SOCKET_DIR = '/run/plb';
export const SANDBOX_SOCKET_PATH = `${SANDBOX_SOCKET_DIR}/broker.sock`;

/** A caller can lower limits but never raise them above MAX_LIMITS, nor below MIN_LIMITS. */
export function clampLimits(req: Partial<Limits> = {}): Limits {
  const pick = (v: number | undefined, d: number, min: number, max: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, min), max) : d);
  return {
    mem_mb: pick(req.mem_mb, DEFAULT_LIMITS.mem_mb, MIN_LIMITS.mem_mb, MAX_LIMITS.mem_mb),
    cpus: pick(req.cpus, DEFAULT_LIMITS.cpus, MIN_LIMITS.cpus, MAX_LIMITS.cpus),
    pids: pick(req.pids, DEFAULT_LIMITS.pids, MIN_LIMITS.pids, MAX_LIMITS.pids),
    wall_s: pick(req.wall_s, DEFAULT_LIMITS.wall_s, MIN_LIMITS.wall_s, MAX_LIMITS.wall_s),
  };
}

/** True when `v` is undefined or an object whose present members are all finite numbers (AG4-SBX-8 type guard). */
export function isLimitsInput(v: unknown): v is Partial<Limits> | undefined {
  if (v === undefined) return true;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'number' && Number.isFinite(x));
}
