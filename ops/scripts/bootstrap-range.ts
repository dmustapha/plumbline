// File: ops/scripts/bootstrap-range.ts
// Owner-run, idempotent. Creates (or reuses) the two infra VMs, plumbline-prod-db, the shared registry plumblinereg, the versioned
// canary bucket and the six IP-locked tier users; writes the env files, the verifier baseline and the ledger the broker adopts.
// Every Vultr mutation goes through an engine ALLOW (owner caller) or an OwnerAction, both recorded in .deploy/ledger.sqlite.
// No key or token value is ever printed; the only stdout line is the summary JSON.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicKeyFromRawB64 } from '@plumbline/policy-engine';
import { Instances, Registries, S3Store, TIER_ACL, type InstanceView, type S3Sender } from '@plumbline/vultr-adapter';
import { ownerContext, OWNER_ENV_FILE, type OwnerContext, type OwnerGrant } from './owner.ts';

export const DEFAULT_OUT = '/Users/MAC/vultr-rush/.deploy';
const DEFAULT_EXPIRY = '2026-11-20T00:00:00Z';
const BUCKET = 'plumbline-orders-db';
const REGISTRY = 'plumblinereg';
const ENV_FILES = ['broker.env', 'api.env', 'runner.env', 'verifier.env', 'watchdog.env'] as const;
const EMPTY_OK = new Set(['PLUMBLINE_SANDBOX_RUNTIME', 'PLUMBLINE_SANDBOX_SOCKET_DIR']); // socket dir is only used by the U-4 fallback transport
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface BootstrapOptions {
  env: NodeJS.ProcessEnv;
  out: string;
  sshKeyId?: string;
  expiry: string;
  rotate: boolean;
  /** `id -u plumbline-watchdog` on VM 2; only known after bootstrap-vm.sh has run there */
  watchdogUid?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  s3Client?: S3Sender;
  pollTries?: number;
}

export interface BootstrapSummary {
  broker_ip: string;
  verifier_ip: string;
  verifier_region: string;
  prod_db: string;
  registry: string;
  users: Record<string, { id: string; how: UserHow }>;
  tokens: 'reused' | 'generated';
  ledger: { decisions: number; resources: number; gaps: string[] };
  pending: string[];
  key_expiry: string;
  env_dir: string;
  next: string;
}

type UserHow = 'created' | 'reused' | 'recreated';
type EnvMap = Record<string, string>;
interface UserSpec { name: string; acls: string[]; ip: string; slot: { file: string; name: string } }

/** AG4-OPS-8: every input the generated files depend on. Names only are ever reported. */
export function missingInputs(env: NodeJS.ProcessEnv, sshKeyId: string | undefined): string[] {
  const need = ['VULTR_API_KEY', 'PLUMBLINE_POLICY_PUBKEY', 'VULTR_INFERENCE_API_KEY', 'VULTR_S3_HOST', 'VULTR_S3_ACCESS_KEY', 'VULTR_S3_SECRET_KEY'];
  const out = need.filter((n) => !env[n] || env[n]?.trim() === '' || env[n] === 'undefined');
  if (!sshKeyId) out.push('VULTR_SSH_KEY_ID (or --ssh-key-id)');
  return out;
}

export function assertInputs(env: NodeJS.ProcessEnv, sshKeyId: string | undefined, expiry: string): void {
  const missing = missingInputs(env, sshKeyId);
  if (missing.length > 0) throw new Error(`BOOTSTRAP_INPUT_MISSING: ${missing.join(', ')}`);
  try { publicKeyFromRawB64(env.PLUMBLINE_POLICY_PUBKEY as string); } catch { throw new Error('BOOTSTRAP_INPUT_INVALID: PLUMBLINE_POLICY_PUBKEY is not a 32-byte base64 ed25519 key'); }
  const t = Date.parse(expiry);
  if (!Number.isFinite(t)) throw new Error('BOOTSTRAP_INPUT_INVALID: --expiry is not an ISO date');
}

export function parseEnvText(text: string): EnvMap {
  const out: EnvMap = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Fills an env example. Refuses any value that is empty, 'undefined' or still a __PLACEHOLDER__ (the file would be a silent footgun). `skip` drops lines whose value only exists after the VM does. */
export function renderEnv(example: string, overrides: EnvMap, hosts: { verifier: string; broker: string }, skip: string[] = []): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of example.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!m) continue;
    const name = m[1] as string;
    seen.add(name);
    if (skip.includes(name) && overrides[name] === undefined) continue;
    const dflt = (m[2] as string).replaceAll('__VERIFIER_HOST__', hosts.verifier).replaceAll('__BROKER_HOST__', hosts.broker);
    lines.push(`${name}=${overrides[name] ?? dflt}`);
  }
  for (const [name, v] of Object.entries(overrides)) if (!seen.has(name)) lines.push(`${name}=${v}`);
  return checkedLines(lines);
}

function checkedLines(lines: string[]): string {
  for (const l of lines) {
    const [name, ...rest] = l.split('=');
    const v = rest.join('=');
    if (/__[A-Z_]+__/.test(v)) throw new Error(`BOOTSTRAP_PLACEHOLDER_LEFT: ${name}`);
    if ((v === '' && !EMPTY_OK.has(name as string)) || v === 'undefined') throw new Error(`BOOTSTRAP_VALUE_MISSING: ${name}`);
  }
  return lines.join('\n') + '\n';
}

function readExisting(out: string): Record<string, EnvMap> {
  const res: Record<string, EnvMap> = {};
  for (const f of ENV_FILES) res[f] = existsSync(`${out}/${f}`) ? parseEnvText(readFileSync(`${out}/${f}`, 'utf8')) : {};
  return res;
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}

async function pollActive(inst: Instances, o: OwnerContext, id: string, tries: number, sleep: (ms: number) => Promise<void>): Promise<InstanceView> {
  for (let i = 0; i < tries; i++) {
    const cur = await inst.get(o.ctx, id);
    if (cur.status === 'active' && cur.server_status === 'ok' && cur.main_ip && cur.main_ip !== '0.0.0.0') return cur;
    await sleep(3000);
  }
  throw new Error(`instance ${id} did not become active`);
}

interface InstanceSpec { label: string; plan: string; region: string | null; tags: string[] }

async function ensureInstance(o: OwnerContext, spec: InstanceSpec, ssh: string[], gaps: string[], tries: number, sleep: (ms: number) => Promise<void>): Promise<InstanceView> {
  const inst = new Instances(o.http);
  const have = (await inst.list(o.ctx)).find((i) => i.label === spec.label);
  if (have) {
    if (have.plan !== spec.plan) throw new Error(`INSTANCE_DRIFT: ${spec.label} plan ${have.plan} != ${spec.plan}`);
    if (!o.ledger.isKnownResource(have.id)) gaps.push(`${spec.label}:${have.id}`);
    return pollActive(inst, o, have.id, tries, sleep);
  }
  const region = spec.region as string;
  const g: OwnerGrant = o.grant('create', 'instance', spec.label, { params: { plan: spec.plan, region }, tags: spec.tags });
  const created = await inst.create(g.allow, g.req, { tags: spec.tags, sshkey_ids: ssh });
  o.recordResource(g, { id: created.id, class: 'instance', label: spec.label, plan: spec.plan, protected: spec.tags.includes('protected') });
  return pollActive(inst, o, created.id, tries, sleep);
}

async function pickSecondRegion(o: OwnerContext): Promise<string> {
  const res = await o.http.request<{ plans: { id: string; locations: string[] }[] }>('GET', '/plans', { session_id: 'owner', query: { per_page: 500 } });
  const locs = res.plans.find((p) => p.id === 'vc2-1c-1gb')?.locations ?? [];
  const pick = ['ord', 'lax', 'dfw', 'sea'].find((r) => locs.includes(r));
  if (!pick) throw new Error('no second region lists vc2-1c-1gb');
  return pick;
}

async function ensureRegistry(o: OwnerContext, gaps: string[]): Promise<string> {
  const reg = new Registries(o.http);
  const have = (await reg.list(o.ctx)).find((r) => r.name === REGISTRY);
  if (have) {
    if (!o.ledger.isKnownResource(have.id)) gaps.push(`${REGISTRY}:${have.id}`);
    return have.id;
  }
  const g = o.grant('create', 'registry', REGISTRY, { params: { name: REGISTRY, region: 'ewr' } });
  const made = await reg.create(g.allow, g.req);
  o.recordResource(g, { id: made.id, class: 'registry', label: REGISTRY, plan: 'start_up', protected: false });
  return made.id;
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** AG4-OPS-7 + U-11: reuse a matching user with a kept key; any drift or rotation recreates the user (deleting a user revokes its keys). */
async function ensureUser(o: OwnerContext, spec: UserSpec, have: { id: string; acls: string[] } | undefined, kept: string | undefined, rotate: boolean, expiry: string): Promise<{ id: string; key: string; how: UserHow }> {
  const ips = have ? await o.admin.ipList(have.id) : [];
  const ipOk = ips.every((e) => e.subnet === spec.ip);
  if (have && kept && !rotate && ipOk && sameSet(have.acls, spec.acls)) {
    if (ips.length === 0) await o.admin.ipAllow(o.action('user.ip_allow', `lock ${spec.name} to ${spec.ip}`), have.id, spec.ip);
    return { id: have.id, key: kept, how: 'reused' };
  }
  if (have) await o.admin.deleteUser(o.action('user.delete', `${rotate ? 'rotation' : 'drift or lost key'}: recreate ${spec.name} (revokes its keys, U-11)`), have.id);
  const { id } = await o.admin.createServiceUser(o.action('user.create', `tier user ${spec.name}`), spec.name, spec.acls);
  await o.admin.ipAllow(o.action('user.ip_allow', `lock ${spec.name} to ${spec.ip}`), id, spec.ip);
  const issued = await o.admin.issueKey(o.action('user.issue_key', `key for ${spec.name}`), id, `${spec.name}-key`, expiry);
  return { id, key: issued.api_key, how: have ? 'recreated' : 'created' };
}

function userSpecs(brokerIp: string, verifierIp: string): UserSpec[] {
  const b = (name: string, acls: string[], file: string, slot: string): UserSpec => ({ name, acls, ip: brokerIp, slot: { file, name: slot } });
  const v = (name: string, acls: string[], file: string, slot: string): UserSpec => ({ name, acls, ip: verifierIp, slot: { file, name: slot } });
  return [
    b('plumbline-observer', [TIER_ACL.observer], 'broker.env', 'VULTR_KEY_OBSERVER'),
    b('plumbline-deployer', [TIER_ACL.deployer], 'broker.env', 'VULTR_KEY_DEPLOYER'),
    b('plumbline-network', [TIER_ACL.network], 'broker.env', 'VULTR_KEY_NETWORK'),
    b('plumbline-registry', [TIER_ACL.registry], 'broker.env', 'VULTR_KEY_REGISTRY'),
    v('plumbline-verifier-ro', [TIER_ACL.observer], 'verifier.env', 'PLUMBLINE_VERIFIER_KEY'),
    v('plumbline-watchdog', [TIER_ACL.deployer, TIER_ACL.network], 'watchdog.env', 'PLUMBLINE_WATCHDOG_KEY'),
  ];
}

async function ensureUsers(o: OwnerContext, specs: UserSpec[], existing: Record<string, EnvMap>, rotate: boolean, expiry: string) {
  const live = new Map((await o.admin.listUsers()).map((u) => [u.name, u]));
  const out: Record<string, { id: string; key: string; how: UserHow }> = {};
  for (const spec of specs) out[spec.name] = await ensureUser(o, spec, live.get(spec.name), existing[spec.slot.file]?.[spec.slot.name], rotate, expiry);
  return out;
}

async function seedBucket(o: OwnerContext, env: NodeJS.ProcessEnv, client: S3Sender | undefined): Promise<void> {
  const store = new S3Store({ host: env.VULTR_S3_HOST as string, accessKey: env.VULTR_S3_ACCESS_KEY as string, secretKey: env.VULTR_S3_SECRET_KEY as string, bucket: BUCKET }, o.gate, client);
  await store.ensureVersionedBucket(o.action('bucket.ensure', `canary bucket ${BUCKET}, versioning on`), o.ctx);
  if ((await store.listVersions(o.ctx, 'orders.json')).versions.length > 0) return;
  for (const [v, orders] of [[1, [1, 2, 3]], [2, [1, 2, 3, 4]]] as const) {
    const g = o.grant('put', 'bucket_object', BUCKET, { id: 'orders.json', params: { key: 'orders.json' } });
    await store.putObject(g.allow, g.req, JSON.stringify({ orders, v }));
  }
}

const secret = (): string => randomBytes(24).toString('hex');

function pickTokens(existing: Record<string, EnvMap>, rotate: boolean): { t: Record<'api' | 'admin' | 'task' | 'lease' | 'runner', string>; reused: boolean } {
  const kept = (f: string, n: string): string | undefined => (rotate ? undefined : existing[f]?.[n]);
  const t = {
    api: kept('broker.env', 'PLUMBLINE_API_TOKEN') ?? secret(), admin: kept('broker.env', 'PLUMBLINE_ADMIN_TOKEN') ?? secret(),
    task: kept('broker.env', 'PLUMBLINE_TASK_HMAC') ?? secret(), lease: kept('broker.env', 'PLUMBLINE_LEASE_SECRET') ?? secret(),
    runner: kept('runner.env', 'PLUMBLINE_RUNNER_TOKEN') ?? secret(),
  };
  return { t, reused: !rotate && Boolean(existing['broker.env']?.PLUMBLINE_API_TOKEN) };
}

const exampleOf = (name: string): string => readFileSync(fileURLToPath(new URL(`../env/${name}.example`, import.meta.url)), 'utf8');
const dashed = (ip: string): string => `${ip.replaceAll('.', '-')}.sslip.io`;

interface Built { files: Record<string, string> }

function buildEnvFiles(o: BootstrapOptions, broker: InstanceView, verifier: InstanceView, keys: Record<string, string>, tk: ReturnType<typeof pickTokens>['t']): Built {
  const e = o.env;
  const pub = e.PLUMBLINE_POLICY_PUBKEY as string;
  const hosts = { verifier: dashed(verifier.main_ip), broker: dashed(broker.main_ip) };
  const verifierUrl = `https://${hosts.verifier}`;
  const brokerOver: EnvMap = {
    PLUMBLINE_API_TOKEN: tk.api, PLUMBLINE_ADMIN_TOKEN: tk.admin, PLUMBLINE_TASK_HMAC: tk.task, PLUMBLINE_LEASE_SECRET: tk.lease, PLUMBLINE_POLICY_PUBKEY: pub,
    PLUMBLINE_VERIFIER_URL: verifierUrl,
    VULTR_KEY_OBSERVER: keys['plumbline-observer'] as string, VULTR_KEY_DEPLOYER: keys['plumbline-deployer'] as string,
    VULTR_KEY_NETWORK: keys['plumbline-network'] as string, VULTR_KEY_REGISTRY: keys['plumbline-registry'] as string,
    VULTR_INFERENCE_API_KEY: e.VULTR_INFERENCE_API_KEY as string, VULTR_S3_HOST: e.VULTR_S3_HOST as string,
    VULTR_S3_ACCESS_KEY: e.VULTR_S3_ACCESS_KEY as string, VULTR_S3_SECRET_KEY: e.VULTR_S3_SECRET_KEY as string,
  };
  const verifierOver: EnvMap = { PLUMBLINE_VERIFIER_KEY: keys['plumbline-verifier-ro'] as string, PLUMBLINE_LEASE_SECRET: tk.lease, PLUMBLINE_POLICY_PUBKEY: pub, ...(o.watchdogUid ? { PLUMBLINE_WATCHDOG_UID: o.watchdogUid } : {}) };
  return {
    files: {
      'broker.env': renderEnv(exampleOf('broker.env'), brokerOver, hosts),
      'api.env': renderEnv(exampleOf('api.env'), { PLUMBLINE_API_TOKEN: tk.api, PLUMBLINE_RUNNER_TOKEN: tk.runner, PLUMBLINE_VERIFIER_URL: verifierUrl, PLUMBLINE_KEY_EXPIRY_ISO: o.expiry }, hosts),
      'runner.env': renderEnv(exampleOf('runner.env'), { PLUMBLINE_RUNNER_TOKEN: tk.runner }, hosts),
      'verifier.env': renderEnv(exampleOf('verifier.env'), verifierOver, hosts, ['PLUMBLINE_WATCHDOG_UID']),
      'watchdog.env': checkedLines([`PLUMBLINE_WATCHDOG_KEY=${keys['plumbline-watchdog']}`, `PLUMBLINE_POLICY_PUBKEY=${pub}`, 'PLUMBLINE_WATCHDOG_DRY_RUN=1']),
    },
  };
}

interface RawInstance { os?: unknown; os_id?: unknown; power_status?: unknown }

/** H-3: the baseline pins power_status and os next to label/plan/region, read from Vultr itself. */
async function baselineEntry(o: OwnerContext, i: InstanceView) {
  const raw = (await o.http.request<{ instance: RawInstance }>('GET', `/instances/${encodeURIComponent(i.id)}`, o.ctx)).instance;
  return { id: i.id, class: 'instance', label: i.label, plan: i.plan, region: i.region, power_status: String(raw.power_status ?? i.power_status), os: String(raw.os ?? ''), os_id: Number(raw.os_id ?? 0), tags: i.tags };
}

function secretsIn(text: string, secrets: string[]): boolean {
  return secrets.some((s) => s.length >= 8 && text.includes(s));
}

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapSummary> {
  assertInputs(opts.env, opts.sshKeyId, opts.expiry);
  mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  const sleep = opts.sleep ?? sleepMs;
  const o = ownerContext({ env: opts.env, fetchImpl: opts.fetchImpl, sleep, ledgerPath: `${opts.out}/ledger.sqlite` });
  try {
    return await bootstrapWith(o, opts, sleep);
  } finally {
    o.close();
  }
}

async function bootstrapWith(o: OwnerContext, opts: BootstrapOptions, sleep: (ms: number) => Promise<void>): Promise<BootstrapSummary> {
  const ssh = [opts.sshKeyId as string];
  const gaps: string[] = [];
  const tries = opts.pollTries ?? 100;
  const existing = readExisting(opts.out);
  const live = await new Instances(o.http).list(o.ctx);
  const region2 = live.find((i) => i.label === 'plumbline-infra-verifier')?.region ?? (await pickSecondRegion(o));
  const broker = await ensureInstance(o, { label: 'plumbline-infra-broker', plan: 'vc2-2c-4gb', region: 'ewr', tags: ['plumbline', 'infra'] }, ssh, gaps, tries, sleep);
  const verifier = await ensureInstance(o, { label: 'plumbline-infra-verifier', plan: 'vc2-1c-1gb', region: region2, tags: ['plumbline', 'infra'] }, ssh, gaps, tries, sleep);
  const prod = await ensureInstance(o, { label: 'plumbline-prod-db', plan: 'vc2-1c-1gb', region: 'ewr', tags: ['plumbline', 'protected'] }, ssh, gaps, tries, sleep);
  const registryId = await ensureRegistry(o, gaps);
  const users = await ensureUsers(o, userSpecs(broker.main_ip, verifier.main_ip), existing, opts.rotate, opts.expiry);
  await seedBucket(o, opts.env, opts.s3Client);
  const tk = pickTokens(existing, opts.rotate);
  const keys = Object.fromEntries(Object.entries(users).map(([n, u]) => [n, u.key]));
  const built = buildEnvFiles(opts, broker, verifier, keys, tk.t);
  for (const [name, text] of Object.entries(built.files)) writeAtomic(`${opts.out}/${name}`, text);
  const baseline = [...(await Promise.all([broker, verifier, prod].map((i) => baselineEntry(o, i)))), { id: registryId, class: 'registry', label: REGISTRY, plan: 'start_up', region: 'ewr' }];
  writeAtomic(`${opts.out}/baseline.json`, JSON.stringify({ generated_at: new Date().toISOString(), resources: baseline }, null, 2));
  const count = (t: string): number => (o.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const summary: BootstrapSummary = {
    broker_ip: broker.main_ip, verifier_ip: verifier.main_ip, verifier_region: region2, prod_db: prod.id, registry: registryId,
    users: Object.fromEntries(Object.entries(users).map(([n, u]) => [n, { id: u.id, how: u.how }])), tokens: tk.reused ? 'reused' : 'generated',
    ledger: { decisions: count('decisions'), resources: count('resources'), gaps },
    pending: opts.watchdogUid ? [] : ['PLUMBLINE_WATCHDOG_UID: on VM 2 after bootstrap-vm.sh run `id -u plumbline-watchdog`, append it to /etc/plumbline/verifier.env (or re-run with --watchdog-uid N)'],
    key_expiry: `UNVERIFIED (U-10): Vultr's create response carries no date_expire; ${opts.expiry} is only the banner value. Check expiry in the console.`,
    env_dir: opts.out,
    next: 'scp ledger.sqlite to the broker data dir, the env files and baseline.json to the VMs (ops/scripts/vm-create.md), then run bootstrap-vm.sh on each',
  };
  const text = JSON.stringify(summary);
  if (secretsIn(text, [...Object.values(keys), ...Object.values(tk.t), opts.env.VULTR_API_KEY as string])) throw new Error('BOOTSTRAP_SECRET_IN_SUMMARY');
  writeAtomic(`${opts.out}/bootstrap-summary.json`, JSON.stringify(summary, null, 2));
  return summary;
}

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  if (existsSync(OWNER_ENV_FILE)) process.loadEnvFile(OWNER_ENV_FILE);
  const sshKeyId = arg('ssh-key-id') ?? process.env.VULTR_SSH_KEY_ID;
  const summary = await runBootstrap({ env: process.env, out: arg('out') ?? DEFAULT_OUT, sshKeyId, expiry: arg('expiry') ?? DEFAULT_EXPIRY, rotate: process.argv.includes('--rotate'), watchdogUid: arg('watchdog-uid') });
  console.log(JSON.stringify(summary));
  if (summary.ledger.gaps.length > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error(`BOOTSTRAP_FAILED: ${(e as Error).message}`); process.exitCode = 1; });
}
