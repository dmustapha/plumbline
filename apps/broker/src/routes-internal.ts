// File: apps/broker/src/routes-internal.ts
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listDecisions, proofCounts, type Bond, type Db, type Ledger } from '@plumbline/ledger';
import { diffRules, verifyPolicySignature } from '@plumbline/policy-engine';
import { classifyDelete, objectVersionCount, restoreTarget, sessionCanaryKey } from '@plumbline/rewind';
import type { TierKeys } from '@plumbline/vultr-adapter';
import type { Approvals } from './approvals.ts';
import type { Config, Secrets } from './config.ts';
import type { Egress } from './egress.ts';
import type { KillSwitch } from './killswitch.ts';
import type { LeaseEmitter } from './lease.ts';
import { buildExport, verifyExportRequest } from './ledgerExport.ts';
import type { LiveList } from './liveList.ts';
import type { LlmProxy, Role } from './llmProxy.ts';
import type { Pipeline, S3Port } from './pipeline.ts';
import type { PolicyStore } from './policyStore.ts';
import { capacityError, pickPlaygroundRegion, Serial } from './playground.ts';
import { PLAYGROUND_SUBNET_SIZE, playgroundSubnet, type Session, type SessionRegistry } from './sessions.ts';
import type { TokenService } from './tokens.ts';

export interface InternalDeps {
  config: Config;
  secrets: Pick<Secrets, 'apiToken' | 'adminToken' | 'leaseSecret' | 'policyPubkeyB64'>;
  db: Db;
  ledger: Ledger;
  bond: Bond;
  tiers: TierKeys;
  pipeline: Pipeline;
  sessions: SessionRegistry;
  policies: PolicyStore;
  tokens: TokenService;
  kill: KillSwitch;
  lease: LeaseEmitter;
  live: LiveList;
  llm: LlmProxy;
  approvals: Approvals;
  egress: Egress;
  s3: S3Port;
  taskModels: Map<string, string>;
  startedAt: number;
  clock: () => number;
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * LIVE FINDING: a decision row is written (append-only) before the call runs, so a create has no Vultr id in its stored detail.
 * The id lives in the resources row tied to the ALLOW (allow_decision_id). Join it on read so every card shows the resource ids it touched;
 * the stored row is never modified.
 */
export function withCreatedIds(db: InternalDeps['db'], rows: ReturnType<typeof listDecisions>): ReturnType<typeof listDecisions> {
  const made = db.prepare('SELECT id FROM resources WHERE allow_decision_id = ?');
  return rows.map((r) => {
    let detail: { vultr_ids?: string[] };
    try { detail = JSON.parse(r.detail_json) as { vultr_ids?: string[] }; } catch { return r; }
    if (r.decision !== 'ALLOW' || (detail.vultr_ids?.length ?? 0) > 0) return r;
    const ids = (made.all(r.id) as { id: string }[]).map((x) => x.id);
    return ids.length === 0 ? r : { ...r, detail_json: JSON.stringify({ ...detail, vultr_ids: ids }) };
  });
}

export function registerInternalRoutes(app: FastifyInstance, d: InternalDeps): void {
  const authed = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const open = req.url.startsWith('/v1/ledger/export') || req.url.startsWith('/v1/admin/');
    if (open) return;
    if (!same(String(req.headers['x-plumbline-api-token'] ?? ''), d.secrets.apiToken)) await reply.code(401).send({ status: 'AUTH_API_TOKEN_INVALID' });
  };
  app.addHook('onRequest', authed);

  const playgroundLock = new Serial();

  /** Creates the session's playground VPC in the first region with room; null playground + a typed error when there is none. */
  const createPlayground = (sid: string): Promise<{ playground: Session['playground']; error: unknown }> => playgroundLock.run(async () => {
    const { playgroundRegions: regions, playgroundCapPerRegion: cap } = d.config;
    const region = pickPlaygroundRegion(d.db, regions, cap);
    if (!region) return { playground: null, error: capacityError(regions, cap) };
    const label = `plumbline-s${sid}-vault`;
    // CO-2 E-2: the playground is a VPC (a firewall group is invisible to the verifier).
    const out = await d.pipeline.runSystem(sid, {
      verb: 'create', class: 'vpc',
      params: { label, region, subnet: playgroundSubnet(sid), subnet_size: PLAYGROUND_SUBNET_SIZE },
      extra: { protectedPlayground: true, ownerSession: sid },
    });
    const created = out.status === 'DECIDED' ? (out.result as { id?: string } | undefined) : undefined;
    return created?.id ? { playground: { id: created.id, label }, error: null } : { playground: null, error: out };
  });

  app.post('/v1/session', async () => {
    const s = d.sessions.create();
    const made = await createPlayground(s.id);
    s.playground = made.playground;
    const canary = await d.pipeline.seedCanary(s.id).then((c) => ({ ...c, error: null }), (e: unknown) => ({ key: null, versions: null, error: String((e as Error).message).slice(0, 160) }));
    return { session_id: s.id, tier: s.tier, playground: s.playground, playground_error: made.error, canary };
  });

  app.post<{ Params: { sid: string }; Body: { tier: 'observer' | 'standard' } }>('/v1/session/:sid/tier', async (req, reply) => {
    if (!['observer', 'standard'].includes(req.body?.tier)) return reply.code(400).send({ status: 'ARGS_INVALID' });
    return { ok: d.sessions.setTier(req.params.sid, req.body.tier) };
  });

  app.post<{ Body: { session_id: string; model?: string } }>('/v1/task', async (req, reply) => {
    if (!d.sessions.get(req.body?.session_id)) return reply.code(404).send({ status: 'SESSION_UNKNOWN' });
    if (d.kill.engaged()) return reply.code(423).send({ status: 'kill-switch-engaged' });
    const task_id = `t-${d.clock().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const t = d.tokens.mint(task_id, req.body.session_id);
    if (req.body.model) d.taskModels.set(task_id, req.body.model);
    return { task_id, token: t.token, exp: t.exp };
  });

  app.post<{ Body: { session_id: string; role: Role; messages: never[]; tools?: unknown[]; tool_choice?: 'auto' | 'required' | 'none'; max_tokens?: number } }>('/v1/llm', async (req, reply) => {
    const b = req.body;
    if (!b || !['planner', 'executor', 'advisory'].includes(b.role) || !Array.isArray(b.messages)) return reply.code(400).send({ status: 'ARGS_INVALID' });
    try {
      return await d.llm.chat(b.session_id, b.role, b.messages, b.tools, b.tool_choice, b.max_tokens);
    } catch (e) {
      return reply.code(503).send({ status: 'OPERATOR_BUSY', detail: String((e as Error).message).slice(0, 120) });
    }
  });

  app.get<{ Querystring: { session_id: string } }>('/v1/live-list', async (req) => d.live.fetch(req.query.session_id ?? 'system'));

  app.get<{ Params: { sid: string } }>('/v1/policy/:sid', async (req) => {
    const p = d.policies.get(req.params.sid);
    return { text: p.text, version: p.doc.version, hash: p.doc.hash, diff: diffRules(d.policies.defaultDoc, p.doc), floor: { version: d.policies.floor.version, hash: d.policies.floor.hash } };
  });

  app.put<{ Params: { sid: string }; Body: { text: string } }>('/v1/policy/:sid', async (req, reply) => {
    if (typeof req.body?.text !== 'string') return reply.code(400).send({ status: 'ARGS_INVALID' });
    const r = d.policies.put(req.params.sid, req.body.text);
    if (!r.ok) return reply.code(422).send({ status: 'POLICY_INVALID', errors: r.errors });
    return r;
  });

  app.post<{ Body: { text?: string; signature?: string } }>('/v1/policy-production', async (req, reply) => {
    const s = verifyPolicySignature(req.body?.text ?? '', req.body?.signature, d.secrets.policyPubkeyB64);
    if (s !== 'OK') return reply.code(403).send({ status: s });
    return reply.code(409).send({ status: 'DEPLOY_ONLY', detail: 'a valid signature is checked at deploy time; no HTTP route writes the production policy' });
  });

  app.post<{ Params: { id: string }; Body: { session_id: string; nonce: string; approve: boolean } }>('/v1/approval/:id', async (req) =>
    d.pipeline.approve(req.body.session_id, req.params.id, req.body.nonce, Boolean(req.body.approve)));

  app.get<{ Querystring: { session_id: string } }>('/v1/approvals', async (req) => d.approvals.pending(req.query.session_id, d.clock()));

  app.get<{ Querystring: { session_id?: string; limit?: string; before_ts?: string } }>('/v1/decisions', async (req) =>
    withCreatedIds(d.db, listDecisions(d.db, { session_id: req.query.session_id, limit: Number(req.query.limit ?? 50), before_ts: req.query.before_ts ? Number(req.query.before_ts) : undefined })));

  app.get('/v1/proof', async () => ({
    counts: proofCounts(d.db),
    spend: d.ledger.display('system'),
    models: d.db.prepare('SELECT model, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens, SUM(usd) AS usd FROM inference_calls GROUP BY model').all(),
    floor: { version: d.policies.floor.version, hash: d.policies.floor.hash },
    session_default: { version: d.policies.defaultDoc.version, hash: d.policies.defaultDoc.hash },
    bond: d.config.bondEnabled ? d.bond.snapshot() : null,
    generated_at: d.clock(),
  }));

  app.get<{ Params: { sid: string } }>('/v1/spend/:sid', async (req) => d.ledger.display(req.params.sid));
  app.post<{ Body: { session_id: string } }>('/v1/acl-self-test', async (req) => d.tiers.aclSelfTest(req.body?.session_id ?? 'system'));
  app.get('/v1/egress-counter', async () => d.egress.readCounter());
  app.get('/v1/bond', async () => ({ enabled: d.config.bondEnabled, ...d.bond.snapshot() }));

  app.get('/v1/status', async () => ({
    ok: true, uptime_s: Math.round((d.clock() - d.startedAt) / 1000), kill_switch: d.kill.view(), lease: d.lease.status(),
    sessions: d.sessions.count(), tiers: d.tiers.availability(), spend: d.ledger.display('system'),
    budget_left_pct: Math.max(0, Math.round((1 - d.ledger.globalSpend() / d.config.globalCapUsd) * 100)),
  }));

  const SESSION_ID = /^[0-9a-f]{8}$/;

  app.get<{ Querystring: { session_id: string } }>('/v1/rewind', async (req, reply) => {
    const sid = req.query.session_id;
    if (!SESSION_ID.test(sid ?? '')) return reply.code(400).send({ status: 'ARGS_INVALID', detail: 'session_id must be a session id' });
    try {
      const listing = await d.s3.listVersions({ session_id: sid }, sessionCanaryKey(sid));
      return { key: sessionCanaryKey(sid), object_versions: objectVersionCount(listing), listing, classify: classifyDelete(listing), restore_target: restoreTarget(listing), bond: d.bond.snapshot(), bond_enabled: d.config.bondEnabled };
    } catch (e) {
      // CO-E: an unreadable listing is never a guessed count; the delete scene then fails closed (object-state-unknown).
      return reply.code(503).send({ status: 'REWIND_UNAVAILABLE', object_versions: null, listing: null, classify: classifyDelete(null), restore_target: null, detail: String((e as Error).message).slice(0, 160), bond: d.bond.snapshot(), bond_enabled: d.config.bondEnabled });
    }
  });

  app.post<{ Body: { session_id: string; action: 'delete' | 'restore' } }>('/v1/rewind/act', async (req, reply) => {
    const sid = req.body?.session_id;
    if (!SESSION_ID.test(sid ?? '') || !d.sessions.get(sid) || !['delete', 'restore'].includes(req.body.action)) return reply.code(400).send({ status: 'ARGS_INVALID' });
    const claims = { task_id: `ui-${d.clock().toString(36)}`, session_id: sid };
    const key = sessionCanaryKey(sid);
    if (req.body.action === 'delete') return d.pipeline.handleCall(claims, { verb: 'delete', class: 'bucket_object', target: { id: key } }, null, 'owner');
    let version: string | null;
    try {
      version = restoreTarget(await d.s3.listVersions({ session_id: sid }, key));
    } catch (e) {
      return reply.code(503).send({ status: 'REWIND_UNAVAILABLE', object_versions: null, detail: String((e as Error).message).slice(0, 160) });
    }
    if (!version) return reply.code(409).send({ status: 'REWIND_UNAVAILABLE', detail: 'no earlier version' });
    return d.pipeline.handleCall(claims, { verb: 'restore', class: 'bucket_object', target: { id: key }, params: { version_id: version } }, null, 'owner');
  });

  app.get('/v1/ledger/export', async (req, reply) => {
    const h = req.headers;
    if (!verifyExportRequest(d.secrets.leaseSecret, String(h['x-plumbline-ts'] ?? ''), String(h['x-plumbline-sig'] ?? ''), d.clock())) {
      return reply.code(401).send({ status: 'AUTH_EXPORT_INVALID' });
    }
    return buildExport(d.db, d.clock());
  });

  app.post<{ Body: { reason?: string } }>('/v1/admin/kill-switch/engage', async (req, reply) => {
    if (!same(String(req.headers['x-plumbline-admin-token'] ?? ''), d.secrets.adminToken)) return reply.code(401).send({ status: 'AUTH_ADMIN_INVALID' });
    d.kill.engage(req.body?.reason ?? 'owner engaged');
    const sent = await d.lease.expireNow();
    // AG4-BRK-6: fail closed. The broker destroys its own fleet whether or not a verifier is configured or reachable.
    const fleet = await d.pipeline.destroyWorkers();
    return { engaged: true, lease_expired_at_verifier: sent, workers_destroyed: fleet.destroyed, workers_failed: fleet.failed };
  });

  app.post('/v1/admin/kill-switch/clear', async (req, reply) => {
    if (!same(String(req.headers['x-plumbline-admin-token'] ?? ''), d.secrets.adminToken)) return reply.code(401).send({ status: 'AUTH_ADMIN_INVALID' });
    d.kill.clear();
    return { engaged: false };
  });
}
