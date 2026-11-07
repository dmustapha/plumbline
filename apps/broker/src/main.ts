// File: apps/broker/src/main.ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Bond, Ledger, LIVE_WORKER_WHERE, openDb, recordUnknownOutcome, type Db } from '@plumbline/ledger';
import { PLAYGROUND_LABEL_RE } from '@plumbline/policy-engine';
import { Firewalls, OutcomeUnknown, RateCardCache, S3Store, TierKeys, VsiClient, VultrHttp, Vpcs } from '@plumbline/vultr-adapter';
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
import { makeInstanceReconciler } from './reclaim.ts';
import { registerInternalRoutes } from './routes-internal.ts';
import { registerSandboxRoutes } from './routes-sandbox.ts';
import { SessionRegistry } from './sessions.ts';
import { TaskState } from './taskState.ts';
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
  // M4: an ambiguous mutation (5xx/timeout) is ledgered as an unknown outcome, which counts against max_instances until reconciled.
  const onUnknown = (u: OutcomeUnknown): void => recordUnknownOutcome(db, { request_id: u.request_id, session_id: u.session_id, method: u.method, path: u.path, estimate_usd: u.estimate_usd, cause: u.cause_message }, clock());
  const tiers = new TierKeys(secrets.vultr, ledger, inject.fetchImpl, onUnknown);
  const rate = new RateCardCache(new VultrHttp({ apiKey: null, gate: ledger, fetchImpl: inject.fetchImpl, onUnknown }), clock);
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
  const tasks = new TaskState();

  const internal = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  registerInternalRoutes(internal, { config, secrets, db, ledger, bond, tiers, pipeline, sessions, policies, tokens, kill, lease, live, llm, approvals, egress, s3, tasks, startedAt: clock(), clock });
  const sandbox = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  registerSandboxRoutes(sandbox, { tokens, pipeline, tasks });

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void> | void): void => {
    const t = setInterval(() => { Promise.resolve(fn()).catch((e: unknown) => console.error(JSON.stringify({ evt: 'timer-error', msg: String((e as Error).message) }))); }, ms);
    t.unref();
    timers.push(t);
  };

  /** Live vpc/firewall_group rows that are a playground: the protected session VPC, or any resource labelled plumbline-s<sid>-<name> (SEC-F2). */
  const playgroundRows = (): { id: string; class: 'vpc' | 'firewall_group'; session_id: string }[] => {
    const rows = db.prepare("SELECT id, class, label, protected, session_id FROM resources WHERE destroyed_at_ms IS NULL AND class IN ('vpc','firewall_group')").all() as { id: string; class: 'vpc' | 'firewall_group'; label: string; protected: number; session_id: string }[];
    return rows.filter((r) => (r.class === 'vpc' && r.protected === 1) || PLAYGROUND_LABEL_RE.test(r.label));
  };

  const reconcileInstances = makeInstanceReconciler({ db, ledger, tiers, clock, cleanup: (sid, cls, id) => pipeline.cleanup(sid, cls, id) });

  const reap = async (): Promise<void> => {
    const now = clock();
    await reconcileInstances(); // M3/M4: close rows whose instance is gone first, so the TTL pass below only deletes what still exists
    // CO-B / SEC-F4: the TTL reaper selects live, unprotected, session-made instances (class + protected, never a label LIKE), whatever ttl a row carries.
    const due = db.prepare(`SELECT id, class, session_id FROM resources WHERE ${LIVE_WORKER_WHERE} AND created_at_ms + ttl_h * 3600000 < ?`).all(now) as { id: string; class: 'instance'; session_id: string }[];
    for (const r of due) await pipeline.cleanup(r.session_id, 'instance', r.id);
    for (const s of sessions.expired(config.sessionIdleMs)) {
      // SEC-F2: every playground-labelled network the session owns goes through the audited cleanup path, not only s.playground.
      const owned = playgroundRows().filter((r) => r.session_id === s.id);
      for (const r of owned) await pipeline.cleanup(s.id, r.class, r.id);
      if (s.playground && !owned.some((r) => r.id === s.playground?.id)) await pipeline.cleanup(s.id, 'vpc', s.playground.id);
      policies.reset(s.id);
      sessions.drop(s.id);
    }
    policies.sweep(config.sessionIdleMs, (sid) => sessions.has(sid));
    tasks.prune(now);
    await sweepOrphanPlaygrounds();
  };

  /**
   * LIVE FINDING: sessions live in memory, so a broker restart orphans their playground networks and the ledger rows stay "active" for ever,
   * eating the 5-VPCs-per-location capacity. Reconcile on every reap: a playground row whose session is gone is deleted through the
   * audited cleanup path, or marked destroyed when Vultr no longer has it.
   * SEC-F1: the existence check is sessions.has(), which never refreshes last_seen (get() did, so playground sessions never expired).
   */

  /**
   * LIVE FINDING: Vultr answered 502 to a playground create that it had in fact carried out, so the VPC exists with no ledger row (the verifier
   * rightly reports RECONCILE_RED_UNLOGGED). A VPC whose label is exactly the playground pattern and that has no ledger row is ours by construction;
   * delete it through the audited cleanup path. It must be seen in TWO consecutive sweeps first, so a create still being recorded is never raced.
   */
  let seenUnrecorded = new Set<string>();
  const reclaimUnrecordedPlaygrounds = async (): Promise<void> => {
    const known = new Set((db.prepare("SELECT id FROM resources WHERE class='vpc'").all() as { id: string }[]).map((r) => r.id));
    const now = new Set<string>();
    const list = await new Vpcs(tiers.http('observer')).list({ session_id: 'system' });
    for (const v of list) {
      if (known.has(v.id) || !PLAYGROUND_LABEL_RE.test(v.label)) continue;
      now.add(v.id);
      if (seenUnrecorded.has(v.id)) await pipeline.cleanup('system', 'vpc', v.id);
    }
    seenUnrecorded = new Set([...now].filter((id) => !seenUnrecorded.has(id)));
  };

  const sweepOrphanPlaygrounds = async (): Promise<void> => {
    await reclaimUnrecordedPlaygrounds();
    const orphans = playgroundRows().filter((r) => !sessions.has(r.session_id));
    if (orphans.length === 0) return;
    const ids = async (cls: 'vpc' | 'firewall_group'): Promise<Set<string>> => {
      if (!orphans.some((r) => r.class === cls)) return new Set();
      const list = cls === 'vpc' ? await new Vpcs(tiers.http('observer')).list({ session_id: 'system' }) : await new Firewalls(tiers.http('network')).list({ session_id: 'system' });
      return new Set(list.map((v) => v.id));
    };
    const live = { vpc: await ids('vpc'), firewall_group: await ids('firewall_group') };
    for (const r of orphans) {
      if (!live[r.class].has(r.id)) ledger.markDestroyed(r.id);
      else await pipeline.cleanup(r.session_id, r.class, r.id);
    }
  };

  return {
    internal, sandbox, ledger, db, pipeline, reap, tokens, tasks, kill, lease, policies, sessions, rate, tiers,
    async start(): Promise<void> {
      await rate.refresh();
      await sweepOrphanPlaygrounds().catch((e: unknown) => console.error(JSON.stringify({ evt: 'orphan-sweep-error', msg: String((e as Error).message) })));
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
