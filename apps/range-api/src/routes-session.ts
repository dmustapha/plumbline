// File: apps/range-api/src/routes-session.ts
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ENV_PROOF_CODE } from '@plumbline/operator';
import { credsOf, sessionCookie } from './creds.ts';
import { rateLimited, relay, sessionFor, type ApiDeps } from './deps.ts';
import { execute, publishRecent } from './run.ts';
import { SessionBook } from './sessionBook.ts';

const DECISION_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** HTTP status for the broker's approval outcomes (AG4-BRK-5): the broker answers 200 with a status word. */
const APPROVAL_HTTP: Record<string, number> = { NOT_FOUND: 404, STALE: 409, BAD_NONCE: 403, DENIED: 200, ARGS_INVALID: 400, REWIND_UNAVAILABLE: 503 };

async function ipSpendUsd(d: ApiDeps, ip: string): Promise<number> {
  const sids = d.book.sessionsOf(ip);
  const each = await Promise.all(sids.map(async (sid) => {
    try {
      const r = await d.broker.call<{ session_usd?: unknown }>('GET', `/v1/spend/${encodeURIComponent(sid)}`);
      return typeof r.json?.session_usd === 'number' ? r.json.session_usd : Number.POSITIVE_INFINITY;
    } catch { return Number.POSITIVE_INFINITY; }
  }));
  return each.reduce((a, b) => a + b, 0);
}

function ipCapReached(d: ApiDeps, spent: number): boolean {
  return spent >= d.config.ipSpendCapUsd;
}

/**
 * SEC-H1: live sessions this address holds. A session counts while it is inside its 60 minute life, had an attack within the idle
 * window (env-proof and reads do not count) and the broker still has it. If the broker cannot answer, the local view stands.
 */
async function liveCount(d: ApiDeps, ip: string): Promise<number> {
  const mine = d.book.liveSessionsOf(ip, d.config.liveIdleMs);
  if (mine.length < d.config.liveSessionsPerIp) return mine.length;
  const r = await d.broker.call<{ alive?: unknown }>('POST', '/v1/sessions/alive', { ids: mine }).catch(() => null);
  const alive = r && r.status === 200 && Array.isArray(r.json?.alive) ? new Set(r.json.alive as string[]) : null;
  return alive ? mine.filter((sid) => alive.has(sid)).length : mine.length;
}

async function createSession(d: ApiDeps, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const current = credsOf(req);
  if (current.sid && d.book.check(current.sid, current.key) === 'OK') return reply.send({ session_id: current.sid, reused: true });
  if (await liveCount(d, req.ip) >= d.config.liveSessionsPerIp) {
    // STRESS L1: like every other 429 this one says when to retry; a live session stops counting after liveIdleMs without an attack, so that is the upper bound
    const retryS = Math.max(1, Math.ceil(d.config.liveIdleMs / 1000));
    return reply.header('retry-after', String(retryS)).code(429).send({ status: 'SESSIONS_PER_IP_LIVE', retry_after_s: retryS, detail: `this address already holds ${d.config.liveSessionsPerIp} live sessions; use one of them or wait for it to idle out (at most ${retryS} s)` });
  }
  const perIp = d.sessionIpLimit.take(req.ip);
  if (!perIp.ok) return rateLimited(reply, perIp.retryAfterS);
  const overall = d.sessionGlobalLimit.take('all');
  if (!overall.ok) return rateLimited(reply, overall.retryAfterS);
  const st = await d.broker.call<{ sessions?: number }>('GET', '/v1/status').catch(() => null);
  if (!st || st.status !== 200) return reply.code(502).send({ status: 'BROKER_UNREACHABLE' });
  if ((st.json.sessions ?? 0) >= d.config.maxSessions) return reply.code(503).send({ status: 'SESSION_CAP', detail: 'the range is full; see /replay' });
  if (ipCapReached(d, await ipSpendUsd(d, req.ip))) return reply.code(429).send({ status: 'IP_SPEND_CAP', detail: 'this address has used its spend allowance; a new session does not reset it' });
  const r = await d.broker.call<{ session_id?: string }>('POST', '/v1/session', {}).catch(() => null);
  if (!r) return reply.code(502).send({ status: 'BROKER_UNREACHABLE' });
  if (r.status !== 200 || !SessionBook.isSessionId(r.json?.session_id)) return reply.code(r.status === 200 ? 502 : r.status).send(r.json);
  const { key, expired } = d.book.register(r.json.session_id, req.ip);
  for (const sid of expired) d.hub.drop(sid);
  reply.header('set-cookie', sessionCookie(r.json.session_id, key, req.protocol === 'https'));
  return reply.send({ ...r.json, session_key: key });
}

type AttackBody = { session_id?: unknown; text?: unknown };

async function startAttack(d: ApiDeps, req: FastifyRequest<{ Body: AttackBody }>, reply: FastifyReply): Promise<FastifyReply> {
  const { session_id: claimed, text } = req.body ?? {};
  if (typeof text !== 'string' || text.trim().length < 3 || text.length > 300) return reply.code(400).send({ status: 'ARGS_INVALID', detail: 'text must be 3..300 characters' });
  const sid = sessionFor(d, req, reply, claimed);
  if (!sid) return reply;
  const gate = d.attackLimit.take(sid);
  if (!gate.ok) return rateLimited(reply, gate.retryAfterS);
  d.book.touch(sid);
  if (ipCapReached(d, await ipSpendUsd(d, req.ip))) return reply.code(429).send({ status: 'IP_SPEND_CAP', detail: 'this address has used its spend allowance across all its sessions' });
  const st = await d.broker.call<{ kill_switch?: { engaged: boolean }; budget_left_pct?: number }>('GET', '/v1/status').catch(() => null);
  if (!st || st.json.kill_switch?.engaged || (st.json.budget_left_pct ?? 100) <= 0) return reply.code(503).send({ status: 'REPLAY', detail: 'the live range is capped; see /replay' });
  if (!d.inFlight.tryEnter()) return reply.code(503).send({ status: 'OPERATOR_BUSY' });
  const attackId = `a-${(d.clock ?? Date.now)().toString(36)}-${randomBytes(2).toString('hex')}`;
  void execute(d, sid, text, attackId).finally(() => d.inFlight.leave());
  return reply.code(202).send({ attack_id: attackId });
}

async function envProof(d: ApiDeps, req: FastifyRequest<{ Body: { session_id?: unknown } }>, reply: FastifyReply): Promise<unknown> {
  const sid = sessionFor(d, req, reply, req.body?.session_id);
  if (!sid) return reply;
  const gate = d.attackLimit.take(sid);
  if (!gate.ok) return rateLimited(reply, gate.retryAfterS);
  // SEC REVIEW (opus) #5: the probe takes a runner slot, so it shares the global in-flight gate with real attacks
  if (!d.inFlight.tryEnter()) return reply.code(503).send({ status: 'OPERATOR_BUSY' });
  try {
    const t = await d.broker.mint(sid, 'direct-sandbox-probe');
    const result = await d.runner.run({ code: ENV_PROOF_CODE, capability: t.capability });
    return { label: 'direct sandbox probe, no model involved', result };
  } catch (e) {
    return reply.code(503).send({ status: 'OPERATOR_BUSY', detail: String((e as Error).message).slice(0, 80) });
  } finally {
    d.inFlight.leave();
  }
}

type PendingApproval = { decision_id: string; nonce: string; call?: { verb?: string; class?: string; id?: string } };

/**
 * AG4-PRD-6: `orders.json` is one object shared by every visitor. Approving the delete of its last copy would destroy it
 * for every later judge, so that approval is refused (deny stays possible). A per-session canary (sessions/<id>/...) or a
 * scene object (bond-scene/...) is only the caller's own and stays approvable.
 */
export function isSharedCanaryDelete(call: PendingApproval['call']): boolean {
  return call?.class === 'bucket_object' && call.verb === 'delete' && (call.id === undefined || call.id === 'orders.json');
}

async function pendingOf(d: ApiDeps, sid: string): Promise<PendingApproval[]> {
  const r = await d.broker.call<PendingApproval[]>('GET', `/v1/approvals?session_id=${encodeURIComponent(sid)}`);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('approvals unavailable');
  return r.json;
}

type ApprovalBody = { nonce?: unknown; approve?: unknown };

async function decideApproval(d: ApiDeps, req: FastifyRequest<{ Params: { id: string }; Body: ApprovalBody }>, reply: FastifyReply): Promise<FastifyReply> {
  const { nonce, approve } = req.body ?? {};
  if (!DECISION_ID.test(req.params.id) || typeof nonce !== 'string' || typeof approve !== 'boolean') return reply.code(400).send({ status: 'ARGS_INVALID' });
  const sid = sessionFor(d, req, reply);
  if (!sid) return reply;
  const gate = d.actLimit.take(sid);
  if (!gate.ok) return rateLimited(reply, gate.retryAfterS);
  try {
    const entry = approve ? (await pendingOf(d, sid)).find((p) => p.decision_id === req.params.id) : undefined;
    if (isSharedCanaryDelete(entry?.call) && entry) return reply.code(409).send({ status: 'SHARED_CANARY_APPROVAL_REFUSED', detail: 'approving this would delete the shared canary for every later visitor; deny is allowed' });
    const r = await d.broker.call<{ status?: string }>('POST', `/v1/approval/${encodeURIComponent(req.params.id)}`, { session_id: sid, nonce, approve });
    const word = String(r.json?.status ?? '');
    if (word === 'DECIDED') await publishRecent(d, sid, (d.clock ?? Date.now)() - 20_000);
    else d.hub.publish(sid, 'approval', { decision_id: req.params.id, status: word });
    return reply.code(APPROVAL_HTTP[word] ?? r.status).send(r.json);
  } catch (e) {
    return reply.code(502).send({ status: 'BROKER_UNREACHABLE', detail: String((e as Error).message).slice(0, 100) });
  }
}

async function listApprovals(d: ApiDeps, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const sid = sessionFor(d, req, reply);
  if (!sid) return reply;
  try {
    return reply.send((await pendingOf(d, sid)).map((p) => ({ ...p, approve_allowed: !isSharedCanaryDelete(p.call) })));
  } catch (e) {
    return reply.code(502).send({ status: 'BROKER_UNREACHABLE', detail: String((e as Error).message).slice(0, 100) });
  }
}

async function rewindAct(d: ApiDeps, req: FastifyRequest<{ Body: { action?: unknown } }>, reply: FastifyReply): Promise<FastifyReply> {
  const action = req.body?.action;
  if (action !== 'delete' && action !== 'restore') return reply.code(400).send({ status: 'ARGS_INVALID' });
  const sid = sessionFor(d, req, reply);
  if (!sid) return reply;
  const gate = d.actLimit.take(sid);
  if (!gate.ok) return rateLimited(reply, gate.retryAfterS);
  const r = await d.broker.call('POST', '/v1/rewind/act', { session_id: sid, action }).catch(() => null);
  if (!r) return reply.code(502).send({ status: 'BROKER_UNREACHABLE' });
  await publishRecent(d, sid, (d.clock ?? Date.now)() - 20_000);
  return reply.code(r.status).send(r.json);
}

export function registerSessionRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.post('/api/session', (req, reply) => createSession(d, req, reply));
  app.post<{ Body: AttackBody }>('/api/attack', (req, reply) => startAttack(d, req, reply));
  app.post<{ Body: { session_id?: unknown } }>('/api/env-proof', (req, reply) => envProof(d, req, reply));
  app.post<{ Params: { id: string }; Body: ApprovalBody }>('/api/approval/:id', (req, reply) => decideApproval(d, req, reply));
  app.get('/api/approvals', (req, reply) => listApprovals(d, req, reply));
  app.post<{ Body: { action?: unknown } }>('/api/rewind/act', (req, reply) => rewindAct(d, req, reply));

  // The caller's own canary only: a client-named or missing session ('system') is never read here (G1f change request).
  app.get('/api/rewind', async (req, reply) => {
    const sid = sessionFor(d, req, reply);
    if (!sid) return reply;
    return relay(reply, d.broker.call('GET', `/v1/rewind?session_id=${encodeURIComponent(sid)}`));
  });

  // Per-session bond: the caller's own bond only (any client-named session is ignored). A caller holding no credential at
  // all gets the broker's counts-only aggregate, never a free amount; a wrong credential is refused like any session route.
  app.get('/api/bond', async (req, reply) => {
    const c = credsOf(req);
    if (!c.sid && !c.key) return relay(reply, d.broker.call('GET', '/v1/bond'));
    const sid = sessionFor(d, req, reply);
    if (!sid) return reply;
    return relay(reply, d.broker.call('GET', `/v1/bond?session_id=${encodeURIComponent(sid)}`));
  });

  app.post<{ Body: { session_id?: unknown } }>('/api/acl-self-test', async (req, reply) => {
    const sid = sessionFor(d, req, reply, req.body?.session_id);
    if (!sid) return reply;
    const gate = d.actLimit.take(sid);
    if (!gate.ok) return rateLimited(reply, gate.retryAfterS);
    return relay(reply, d.broker.call('POST', '/v1/acl-self-test', { session_id: sid }));
  });

  app.post<{ Params: { sid: string }; Body: { tier?: unknown } }>('/api/session/:sid/tier', async (req, reply) => {
    if (req.body?.tier !== 'observer' && req.body?.tier !== 'standard') return reply.code(400).send({ status: 'ARGS_INVALID' });
    const sid = sessionFor(d, req, reply, req.params.sid);
    if (!sid) return reply;
    return relay(reply, d.broker.call('POST', `/v1/session/${encodeURIComponent(sid)}/tier`, { tier: req.body.tier }));
  });
}
