// File: apps/broker/src/config.ts
export interface Config {
  dataDir: string;
  socketPath: string;
  sandboxBind: string;
  sandboxPort: number;
  sessionCeilingUsd: number;
  globalCapUsd: number;
  maxInstances: number;
  bondEnabled: boolean;
  bondUsd: number;
  bondBurnUsd: number;
  floorPath: string;
  floorSigPath: string;
  sessionDefaultPath: string;
  requireFloorSig: boolean;
  verifierUrl: string | null;
  leaseTtlS: number;
  bucket: string;
  rangeApiUrl: string;
  s3Host: string;
  sessionIdleMs: number;
  /** Ordered regions a session playground VPC may be created in; each must be inside the floor's vpc region allow-list. */
  playgroundRegions: string[];
  /** Live protected playground VPCs allowed per region (the account allows 5 VPCs per location; 4 leaves headroom). */
  playgroundCapPerRegion: number;
}

export interface Secrets {
  apiToken: string;
  adminToken: string;
  taskHmac: string;
  leaseSecret: string;
  policyPubkeyB64: string;
  vultr: { observer: string | null; deployer: string | null; network: string | null; registry: string | null };
  inferenceKey: string;
  s3: { accessKey: string; secretKey: string };
}

type Env = Record<string, string | undefined>;

function need(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`BOOT_REFUSED: missing ${name}`);
  return v;
}

const num = (env: Env, name: string, dflt: number): number => {
  const v = env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`BOOT_REFUSED: ${name} is not a number`);
  return n;
};

const list = (env: Env, name: string, dflt: string): string[] => {
  const items = (env[name] || dflt).split(',').map((x) => x.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`BOOT_REFUSED: ${name} names no region`);
  return items;
};

const positive = (env: Env, name: string, dflt: number): number => {
  const n = num(env, name, dflt);
  if (!Number.isInteger(n) || n < 1) throw new Error(`BOOT_REFUSED: ${name} must be an integer >= 1`);
  return n;
};

export function loadConfig(env: Env): { config: Config; secrets: Secrets } {
  if (env.PLUMBLINE_MOCK_VULTR) throw new Error('BOOT_REFUSED: the mock Vultr client cannot be selected in a deployed build');
  if (env.VULTR_API_KEY) throw new Error('BOOT_REFUSED: the owner key VULTR_API_KEY must never be present on the broker VM');
  const config: Config = {
    dataDir: env.PLUMBLINE_DATA_DIR ?? '/var/lib/plumbline',
    socketPath: env.PLUMBLINE_SOCKET ?? '/run/plumbline/broker.sock',
    sandboxBind: env.PLUMBLINE_SANDBOX_BIND ?? '172.17.0.1',
    sandboxPort: num(env, 'PLUMBLINE_SANDBOX_PORT', 7443),
    sessionCeilingUsd: num(env, 'PLUMBLINE_SESSION_CEILING_USD', 1.5),
    globalCapUsd: num(env, 'PLUMBLINE_GLOBAL_CAP_USD', 10),
    maxInstances: num(env, 'PLUMBLINE_MAX_INSTANCES', 4),
    bondEnabled: env.PLUMBLINE_BOND_ENABLED === '1',
    bondUsd: num(env, 'PLUMBLINE_BOND_USD', 0.05),
    bondBurnUsd: num(env, 'PLUMBLINE_BOND_BURN_USD', 0.045),
    floorPath: env.PLUMBLINE_FLOOR_PATH ?? '/opt/plumbline/app/policy/floor.yaml',
    floorSigPath: env.PLUMBLINE_FLOOR_SIG_PATH ?? '/opt/plumbline/app/policy/floor.yaml.sig',
    sessionDefaultPath: env.PLUMBLINE_SESSION_DEFAULT_PATH ?? '/opt/plumbline/app/policy/session-default.yaml',
    requireFloorSig: env.PLUMBLINE_REQUIRE_FLOOR_SIG !== '0',
    verifierUrl: env.PLUMBLINE_VERIFIER_URL ?? null,
    leaseTtlS: num(env, 'PLUMBLINE_LEASE_TTL_S', 45),
    bucket: env.PLUMBLINE_BUCKET ?? 'plumbline-orders-db',
    rangeApiUrl: env.PLUMBLINE_RANGE_API_URL ?? 'http://127.0.0.1:8080',
    s3Host: need(env, 'VULTR_S3_HOST'),
    sessionIdleMs: num(env, 'PLUMBLINE_SESSION_IDLE_MIN', 10) * 60_000,
    playgroundRegions: list(env, 'PLUMBLINE_PLAYGROUND_REGIONS', 'ewr,ord'),
    playgroundCapPerRegion: positive(env, 'PLUMBLINE_PLAYGROUND_CAP_PER_REGION', 4),
  };
  const secrets: Secrets = {
    apiToken: need(env, 'PLUMBLINE_API_TOKEN'),
    adminToken: need(env, 'PLUMBLINE_ADMIN_TOKEN'),
    taskHmac: need(env, 'PLUMBLINE_TASK_HMAC'),
    leaseSecret: need(env, 'PLUMBLINE_LEASE_SECRET'),
    policyPubkeyB64: need(env, 'PLUMBLINE_POLICY_PUBKEY'),
    vultr: {
      observer: env.VULTR_KEY_OBSERVER ?? null,
      deployer: env.VULTR_KEY_DEPLOYER ?? null,
      network: env.VULTR_KEY_NETWORK ?? null,
      registry: env.VULTR_KEY_REGISTRY ?? null,
    },
    inferenceKey: need(env, 'VULTR_INFERENCE_API_KEY'),
    s3: { accessKey: need(env, 'VULTR_S3_ACCESS_KEY'), secretKey: need(env, 'VULTR_S3_SECRET_KEY') },
  };
  return { config, secrets };
}
