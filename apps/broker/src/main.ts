// File: apps/broker/src/main.ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Bond, Ledger, openDb, type Db } from '@plumbline/ledger';
import { RateCardCache, S3Store, TierKeys, VsiClient, VultrHttp } from '@plumbline/vultr-adapter';
import { brokerKeyGuard } from './canary.ts';
import { ApprovalAuthority, Approvals } from './approvals.ts';
import { loadConfig, type Config, type Secrets } from './config.ts';
import { Egress } from './egress.ts';
import { KillSwitch } from './killswitch.ts';
import { LeaseEmitter } from './lease.ts';
import { LiveList } from './liveList.ts';
import { LlmProxy } from './llmProxy.ts';
import { Pipeline, type S3Port } from './pipeline.ts';
import { PolicyStore } from './policyStore.ts';
import { registerInternalRoutes } from './routes-internal.ts';
import { registerSandboxRoutes } from './routes-sandbox.ts';
import { SessionRegistry } from './sessions.ts';
import { TokenService } from './tokens.ts';

export interface Inject {
  fetchImpl?: typeof fetch;
  s3?: S3Port;
  db?: Db;
  clock?: () => number;
  policies?: PolicyStore;
}

export async function assemble(config: Config, secrets: Secrets, inject: Inject = {}) {
  const clock = inject.clock ?? Date.now;
  mkdirSync(config.dataDir, { recursive: true });
  const db = inject.db ?? openDb(join(config.dataDir, 'ledger.sqlite'));
  const ledger = new Ledger(db, { session_ceiling_usd: config.sessionCeilingUsd, global_cap_usd: config.globalCapUsd }, clock);
  const bond = new Bond(db, config.bondUsd);
  const tokens = new TokenService(secrets.taskHmac, clock);
  const kill = new KillSwitch(join(config.dataDir, 'killswitch'), tokens);
  const tiers = new TierKeys(secrets.vultr, ledger, inject.fetchImpl);
  const rate = new RateCardCache(new VultrHttp({ apiKey: null, gate: ledger, fetchImpl: inject.fetchImpl }), clock);
  const realS3 = inject.s3 ? null : new S3Store({ host: config.s3Host, accessKey: secrets.s3.accessKey, secretKey: secrets.s3.secretKey, bucket: config.bucket, keyGuard: brokerKeyGuard(config.bondEnabled) }, ledger);
  const s3: S3Port = inject.s3 ?? (realS3 as S3Store);
  // AG4-ADP-7: object storage counts as available only while a real store is healthy (the injected fake is test-only).
  tiers.registerObjstore(realS3 ?? { healthy: () => true });
  const policies = inject.policies ?? PolicyStore.fromFiles(config.dataDir, config.floorPath, config.floorSigPath, config.sessionDefaultPath, secrets.policyPubkeyB64, config.requireFloorSig);
  const sessions = new SessionRegistry(clock);
  const approvals = new Approvals(db);
  const authority = new ApprovalAuthority();
  const egress = new Egress(config.rangeApiUrl, inject.fetchImpl);
  const lease = new LeaseEmitter(config.verifierUrl, secrets.leaseSecret, config.leaseTtlS, inject.fetchImpl, clock);
  const pipeline = new Pipeline({ config, db, ledger, bond, tiers, rate, s3, policies, sessions, kill, approvals, authority, egress, clock });
  const live = new LiveList(tiers, s3, clock);
  const llm = new LlmProxy(new VsiClient(secrets.inferenceKey, ledger, inject.fetchImpl), ledger);
  const taskModels = new Map<string, string>();

  const internal = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  registerInternalRoutes(internal, { config, secrets, db, ledger, bond, tiers, pipeline, sessions, policies, tokens, kill, lease, live, llm, approvals, egress, s3, taskModels, startedAt: clock(), clock });
  const sandbox = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  registerSandboxRoutes(sandbox, { tokens, pipeline, taskModels });

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void> | void): void => {
    const t = setInterval(() => { Promise.resolve(fn()).catch((e: unknown) => console.error(JSON.stringify({ evt: 'timer-error', msg: String((e as Error).message) }))); }, ms);
    t.unref();
    timers.push(t);
  };

  const reap = async (): Promise<void> => {
    const now = clock();
    // CO-B (defence in depth): the TTL reaper only ever selects unprotected plumbline-wk-* workers, whatever ttl a row carries.
    const due = db.prepare("SELECT id, class, session_id FROM resources WHERE destroyed_at_ms IS NULL AND class='instance' AND protected = 0 AND label LIKE 'plumbline-wk-%' AND created_at_ms + ttl_h * 3600000 < ?").all(now) as { id: string; class: 'instance'; session_id: string }[];
    for (const r of due) await pipeline.cleanup(r.session_id, 'instance', r.id);
    for (const s of sessions.expired(config.sessionIdleMs)) {
      if (s.playground) await pipeline.cleanup(s.id, 'vpc', s.playground.id);
      policies.reset(s.id);
      sessions.drop(s.id);
    }
  };

  return {
    internal, sandbox, ledger, db, pipeline, reap, tokens, kill, lease, policies, sessions, rate, tiers,
    async start(): Promise<void> {
      await rate.refresh();
      every(60_000, () => rate.refresh());
      every(60_000, reap);
      lease.start();
      rmSync(config.socketPath, { force: true });
      await internal.listen({ path: config.socketPath });
      chmodSync(config.socketPath, 0o660);
      await sandbox.listen({ host: config.sandboxBind, port: config.sandboxPort });
      console.log(JSON.stringify({ evt: 'broker-listening', socket: config.socketPath, sandbox: `${config.sandboxBind}:${config.sandboxPort}`, floor: policies.floor.hash.slice(0, 12) }));
    },
    async stop(): Promise<void> {
      timers.forEach(clearInterval);
      lease.stop();
      await internal.close();
      await sandbox.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*\/apps\//, '/apps/'));
if (isMain) {
  const { config, secrets } = loadConfig(process.env);
  const app = await assemble(config, secrets);
  await app.start();
  const down = (): void => { void app.stop().then(() => process.exit(0)); };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
}
