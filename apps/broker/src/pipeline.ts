// File: apps/broker/src/pipeline.ts
import { randomBytes, createHash } from 'node:crypto';
import {
  ApprovalError, PLAYGROUND_LABEL_RE, VERB_CLASS, canonicalJson, evaluate, isKnownCall, type AllowDecision, type Caller, type CallRequest, type Decision,
  type EscalateDecision, type Params, type PolicyDoc, type ResourceClass, type Target, type Verb,
} from '@plumbline/policy-engine';
import { recordDecision, recordEvent, type Bond, type Db, type Ledger } from '@plumbline/ledger';
import {
  Firewalls, Instances, Registries, SpendRefused, TierUnavailable, VultrError, Vpcs, type RateCardCache, type S3Store, type TierKeys,
} from '@plumbline/vultr-adapter';
import { ensureCanaryVersions, sessionCanaryKey } from '@plumbline/rewind';
import { canaryKeyFor } from './canary.ts';
import type { Config } from './config.ts';
import type { ApprovalAuthority, Approvals, Binding } from './approvals.ts';
import { EgressRefused, type Egress } from './egress.ts';
import type { KillSwitch } from './killswitch.ts';
import type { PolicyStore } from './policyStore.ts';
import type { SessionRegistry } from './sessions.ts';
import { buildState } from './state.ts';

export type S3Port = Pick<S3Store, 'listVersions' | 'putObject' | 'deleteObject' | 'restoreVersion' | 'getObject'>;

export interface PipelineDeps {
  config: Config;
  db: Db;
  ledger: Ledger;
  bond: Bond;
  tiers: TierKeys;
  rate: RateCardCache;
  s3: S3Port;
  policies: PolicyStore;
  sessions: SessionRegistry;
  kill: KillSwitch;
  approvals: Approvals;
  authority: ApprovalAuthority;
  egress: Egress;
  clock: () => number;
}

/** Parameters the broker accepts on the wire. Every one of them is part of CallRequest.params, so the engine and the request hash see them (AG4-BRK-2). */
export interface WireParams extends Params {
  content?: string;
  port?: string;
  notes?: string;
  firewall_group_id?: string;
}

/** Broker-internal flags that never come from the wire. */
export interface Extra {
  protectedPlayground?: boolean;
  ownerSession?: string;
}

export interface ParsedCall {
  verb: Verb;
  class: ResourceClass;
  id?: string;
  params: WireParams;
  extra: Extra;
}

export interface PublicDecision {
  decision_id: string;
  ts: number;
  decision: 'ALLOW' | 'ESCALATE' | 'DENY';
  rule_id: string;
  layer: string;
  reason: string;
  layers: Decision['layers'];
  policy_version: string;
  projected_cost_usd: number;
  model: string | null;
}

export type Outcome =
  | { status: 'ARGS_INVALID'; errors: string[] }
  | { status: 'REWIND_UNAVAILABLE'; message: string }
  | { status: 'DECIDED'; decision: PublicDecision; result?: unknown; approval?: { nonce: string }; error?: { code: string; message: string; body?: unknown } };

export type ApproveOutcome = Outcome | { status: 'NOT_FOUND' | 'DENIED' | 'STALE' | 'BAD_NONCE' };

/** Every (class:verb) pair the dispatcher can execute. A test pins this to the engine catalog (AG4-BRK-1). */
export const DISPATCH_KEYS = [
  'instance:list', 'instance:create', 'instance:update', 'instance:delete',
  'firewall_group:list', 'firewall_group:create', 'firewall_group:update', 'firewall_group:delete',
  'vpc:list', 'vpc:create', 'vpc:delete',
  'registry:list', 'registry:create', 'registry:delete',
  'bucket_object:list', 'bucket_object:put', 'bucket_object:restore', 'bucket_object:delete',
  'http:fetch', 'policy:read', 'policy:write', 'ledger:read',
] as const;

const PARAM_KEYS = new Set(['plan', 'region', 'ttl_h', 'label', 'url', 'key', 'version_id', 'name', 'subnet', 'subnet_size', 'content', 'port', 'notes', 'firewall_group_id']);
const SAFE = /^[A-Za-z0-9._:/-]{1,128}$/;
const LABEL = /^[A-Za-z0-9._-]{1,63}$/;
const NOTES = /^[A-Za-z0-9 ._:/-]{1,64}$/;
const CONTENT = /^[\t\n\r\x20-\x7e]*$/;
const PORT = /^(\d{1,5})(?::(\d{1,5}))?$/;
const WORKER_PREFIX = 'plumbline-wk-';
const SESSION_PREFIX = 'plumbline-s';
const FOREIGN_LABEL = 'owned-by-another-session';

function portIsValid(v: string): boolean {
  const m = PORT.exec(v);
  if (!m) return false;
  const [lo, hi] = [Number(m[1]), m[2] === undefined ? Number(m[1]) : Number(m[2])];
  return lo >= 1 && hi <= 65535 && lo <= hi;
}

/** Returns an error message, or null when the value is acceptable for key k. */
function checkParam(k: string, v: unknown): string | null {
  if (k === 'ttl_h' || k === 'subnet_size') {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 744 ? null : `${k} must be a number in (0, 744]`;
  }
  if (typeof v !== 'string' || v.length > (k === 'content' ? 2000 : 512)) return `${k} must be a string`;
  if (k === 'content') return CONTENT.test(v) ? null : 'content has illegal characters';
  if (k === 'port') return portIsValid(v) ? null : 'port must be N or N:M within 1-65535';
  if (k === 'notes') return NOTES.test(v) ? null : 'notes has illegal characters';
  if (k === 'label') return LABEL.test(v) ? null : 'label has illegal characters';
  if (k === 'url') return null;
  return SAFE.test(v) ? null : `${k} has illegal characters`;
}

function checkRequired(verb: Verb, cls: ResourceClass, id: string | undefined, params: WireParams): string[] {
  const errors: string[] = [];
  const needsId = ['update', 'delete', 'restore'].includes(verb) || (verb === 'put' && cls === 'bucket_object');
  if (needsId && !id && cls !== 'policy') errors.push('target.id is required for this verb');
  if (verb === 'create' && cls === 'instance' && (!params.plan || !params.region)) errors.push('create instance needs plan and region');
  if (verb === 'create' && cls === 'vpc' && (!params.region || !params.subnet || !params.subnet_size)) errors.push('create vpc needs region, subnet, subnet_size');
  if (verb === 'create' && cls === 'registry' && (!params.name || !params.region)) errors.push('create registry needs name and region');
  if (verb === 'restore' && !params.version_id) errors.push('restore needs params.version_id');
  if (verb === 'fetch' && !params.url) errors.push('fetch needs params.url');
  if (verb === 'update' && cls === 'instance' && !params.firewall_group_id) errors.push('update instance needs a non-empty params.firewall_group_id');
  if (verb === 'update' && cls === 'firewall_group' && !params.port) errors.push('update firewall_group needs params.port');
  return errors;
}

function parseParams(p: unknown, errors: string[]): WireParams {
  const params: WireParams = {};
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    errors.push('params must be an object');
    return params;
  }
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (!PARAM_KEYS.has(k)) { errors.push(`unknown param "${k}"`); continue; }
    const err = checkParam(k, v);
    if (err) errors.push(err);
    else (params as Record<string, unknown>)[k] = v;
  }
  return params;
}

export function parseCall(raw: unknown): { ok: true; call: ParsedCall } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['body must be an object'] };
  const o = raw as Record<string, unknown>;
  if (typeof o.verb !== 'string' || o.verb.length > 16) errors.push('verb must be a short string');
  if (typeof o.class !== 'string' || o.class.length > 24) errors.push('class must be a short string');
  const params = parseParams(o.params ?? {}, errors);
  let id: string | undefined;
  const t = o.target;
  if (t !== undefined && (typeof t !== 'object' || t === null || Array.isArray(t))) errors.push('target must be an object');
  else if (t && typeof (t as Record<string, unknown>).id === 'string') {
    const tid = (t as { id: string }).id;
    if (!SAFE.test(tid)) errors.push('target.id has illegal characters');
    else id = tid;
  }
  if (errors.length > 0) return { ok: false, errors };
  // AG4-BRK-1: the pair must be in the engine catalog, so the verb that is scored is the verb that runs.
  if (!Object.hasOwn(VERB_CLASS, o.class as string) || !isKnownCall(o.verb as string, o.class as string)) return { ok: false, errors: ['verb/class pair is not in the catalog'] };
  const verb = o.verb as Verb;
  const cls = o.class as ResourceClass;
  const missing = checkRequired(verb, cls, id, params);
  if (missing.length > 0) return { ok: false, errors: missing };
  return { ok: true, call: { verb, class: cls, id, params, extra: {} } };
}

interface WireTarget extends Target {
  /** Owning session from the broker ledger (BRK-3); null when the ledger has no row. Carried so the engine and verifier can use it. */
  owner_session?: string | null;
}

interface Resolved {
  target: WireTarget;
  versions: number | null;
}

interface Who {
  task_id: string;
  session_id: string;
  ledger_session: string;
  system: boolean;
  caller: Caller;
  /** Only Pipeline.cleanup sets this: lets a delete through the kill switch (AG4-BRK-6). */
  cleanup?: boolean;
}

type Evaluated =
  | { unavailable: string }
  | { refused: string }
  | { decision: Decision; request: CallRequest; resolved: Resolved };

const hasMarker = (s: string): boolean => s.toLowerCase().includes('[protected]');
const short = (): string => randomBytes(3).toString('hex');
const fingerprint = (t: Target): string => createHash('sha256').update(canonicalJson({ id: t.id ?? null, label: t.label ?? null, tags: [...(t.tags ?? [])].sort(), resolved: t.resolved === true })).digest('hex');
const inCleanupScope = (cls: string, label: string | undefined): boolean =>
  label !== undefined && (cls === 'instance' ? label.startsWith(WORKER_PREFIX) : (cls === 'vpc' || cls === 'firewall_group') && PLAYGROUND_LABEL_RE.test(label));

export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  #ownerOf(id: string | undefined): string | null {
    if (!id) return null;
    const row = this.d.db.prepare('SELECT session_id FROM resources WHERE id = ? AND destroyed_at_ms IS NULL').get(id) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /** The ledger row written at creation says whether the broker made this resource protected (a VPC label cannot carry the [protected] marker). */
  #protectedRow(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.d.db.prepare('SELECT protected FROM resources WHERE id = ? AND destroyed_at_ms IS NULL').get(id) as { protected: number } | undefined;
    return row?.protected === 1;
  }

  async #resolve(call: ParsedCall, sid: string, taskId: string): Promise<Resolved | { unavailable: string }> {
    const ctx = { session_id: sid };
    const { verb, class: cls, id, params } = call;
    if (cls === 'bucket_object') return this.#resolveBucket(verb, id ?? canaryKeyFor(sid), ctx);
    if (verb === 'create') {
      const label = params.label ?? params.name ?? (cls === 'instance' ? `${WORKER_PREFIX}${taskId.slice(0, 4)}${short()}` : undefined);
      return { target: { label }, versions: null };
    }
    if (!id || !['instance', 'firewall_group', 'vpc', 'registry'].includes(cls) || verb === 'list') return { target: { id }, versions: null };
    let target: WireTarget;
    try {
      target = await this.#lookup(cls, id, ctx);
    } catch {
      target = { id };
    }
    return { target: this.#withOwnership(verb, target, sid), versions: null };
  }

  async #resolveBucket(verb: Verb, key: string, ctx: { session_id: string }): Promise<Resolved | { unavailable: string }> {
    const base: WireTarget = { id: key, label: this.d.config.bucket, tags: [] };
    if (verb === 'list') return { target: base, versions: null };
    try {
      const l = await this.d.s3.listVersions(ctx, key);
      return { target: { ...base, resolved: true }, versions: l.versions.length };
    } catch (e) {
      const msg = String((e as Error).message);
      // CO-E: a key the guard refuses never reaches the engine; any other listing error on a delete leaves the version
      // count unknown (null), so the engine itself DENYs object-state-unknown and the decision is ledgered.
      if (verb === 'delete' && !msg.startsWith('SESSION_KEY_FORBIDDEN')) return { target: { ...base, resolved: true }, versions: null };
      return { unavailable: msg };
    }
  }

  /** AG4-BRK-3: a session-scoped resource that this session does not own is presented to the engine as out of scope. */
  #withOwnership(verb: Verb, target: WireTarget, sid: string): WireTarget {
    if (!target.resolved) return target;
    const owner = this.#ownerOf(target.id);
    const withOwner: WireTarget = { ...target, owner_session: owner };
    const label = target.label ?? '';
    const scoped = label.startsWith(WORKER_PREFIX) || label.startsWith(SESSION_PREFIX);
    if (!['update', 'delete'].includes(verb) || !scoped || owner === sid) return withOwner;
    return { ...withOwner, label: FOREIGN_LABEL, tags: [...(target.tags ?? []), 'foreign-session'] };
  }

  async #lookup(cls: ResourceClass, id: string, ctx: { session_id: string }): Promise<WireTarget> {
    const t = this.d.tiers;
    if (cls === 'instance') {
      const found = (await new Instances(t.http('observer')).list(ctx)).find((i) => i.id === id);
      return found ? { id, label: found.label, tags: found.tags, resolved: true } : { id };
    }
    if (cls === 'firewall_group') {
      const found = (await new Firewalls(t.http('network')).list(ctx)).find((f) => f.id === id);
      return found ? { id, label: found.description, tags: hasMarker(found.description) ? ['protected'] : [], resolved: true } : { id };
    }
    if (cls === 'vpc') {
      const found = (await new Vpcs(t.http('observer')).list(ctx)).find((v) => v.id === id);
      return found ? { id, label: found.description, tags: hasMarker(found.description) || this.#protectedRow(id) ? ['protected'] : [], resolved: true } : { id };
    }
    const found = (await new Registries(t.http('observer')).list(ctx)).find((r) => r.id === id);
    return found ? { id, label: found.name, tags: [], resolved: true } : { id };
  }

  async #evaluate(call: ParsedCall, who: Who, requestId?: string): Promise<Evaluated> {
    const resolved = await this.#resolve(call, who.ledger_session, who.task_id);
    if ('unavailable' in resolved) return resolved;
    if (who.cleanup && !inCleanupScope(call.class, resolved.target.label)) {
      recordEvent(this.d.db, 'CLEANUP_REFUSED', who.ledger_session, { class: call.class, id: call.id ?? null, label: resolved.target.label ?? null }, this.d.clock());
      return { refused: 'cleanup path only deletes plumbline-wk-* instances and plumbline-s<sid>-* playground VPCs' };
    }
    const request: CallRequest = {
      request_id: requestId ?? `q-${randomBytes(6).toString('hex')}`, task_id: who.task_id, session_id: who.session_id,
      verb: call.verb, class: call.class, target: resolved.target, params: this.#boundParams(call, resolved.target), caller: who.caller,
    };
    const policy: PolicyDoc = who.system ? this.d.policies.systemDoc : this.d.policies.get(who.ledger_session).doc;
    const state = buildState({ ...this.d, kill: this.d.kill, bond: this.d.bond }, who.ledger_session, { versions: resolved.versions });
    // AG4-BRK-6: only the audited cleanup path (delete of a worker or playground group) is exempt from the kill switch.
    const decision = evaluate(request, policy, this.d.policies.floor, who.cleanup ? { ...state, kill_switch: false } : state);
    return { decision, request, resolved };
  }

  /** The adapter reads label and key only from the ALLOWed request, so the broker writes them into params (hash-bound). */
  #boundParams(call: ParsedCall, target: Target): WireParams {
    const { verb, class: cls, params } = call;
    if (verb === 'create' && cls !== 'registry' && target.label !== undefined) return { ...params, label: target.label };
    if (cls === 'bucket_object' && verb !== 'list') return { ...params, key: target.id };
    return params;
  }

  #record(d: { decision: Decision; request: CallRequest }, call: ParsedCall, who: Who, model: string | null, extraCall: Record<string, unknown> = {}) {
    const quoted = { verb: call.verb, class: call.class, id: call.id ?? null, params: call.params, target: d.request.target, caller: who.caller, ...extraCall };
    return recordDecision(this.d.db, d.decision, { session_id: who.session_id, task_id: who.task_id, model, call: quoted, vultr_ids: call.id ? [call.id] : [], request: d.request }, this.d.clock());
  }

  #publicOf(d: Decision, rec: { id: string; ts: number }, model: string | null): PublicDecision {
    return {
      decision_id: rec.id, ts: rec.ts, decision: d.decision, rule_id: d.rule_id, layer: d.layer, reason: d.reason,
      layers: d.layers, policy_version: d.policy_version, projected_cost_usd: d.projected_cost_usd, model,
    };
  }

  /** The sandbox route passes caller 'sandbox' (default). Only authenticated owner routes may pass 'owner'. */
  async handleCall(claims: { task_id: string; session_id: string }, raw: unknown, model: string | null = null, caller: Caller = 'sandbox'): Promise<Outcome> {
    const parsed = parseCall(raw);
    if (!parsed.ok) {
      recordEvent(this.d.db, 'ARGS_INVALID', claims.session_id, { errors: parsed.errors }, this.d.clock());
      return { status: 'ARGS_INVALID', errors: parsed.errors };
    }
    return this.#run(parsed.call, { task_id: claims.task_id, session_id: claims.session_id, ledger_session: claims.session_id, system: false, caller }, model);
  }

  async runSystem(sid: string, call: ParsedCall): Promise<Outcome> {
    return this.#run(call, { task_id: `sys-${short()}`, session_id: 'system', ledger_session: sid, system: true, caller: 'owner' }, null);
  }

  /**
   * AG4-BRK-6: the broker's own TTL reaper, session sweep and kill-switch fleet destroy. It may only DELETE a
   * plumbline-wk-* instance or a plumbline-s<sid>-* playground VPC, still passes the engine (kill switch aside)
   * and is ledgered with system_cleanup: true.
   */
  async cleanup(ownerSid: string, cls: 'instance' | 'vpc' | 'firewall_group', id: string): Promise<Outcome> {
    const call: ParsedCall = { verb: 'delete', class: cls, id, params: {}, extra: {} };
    const who: Who = { task_id: `reap-${short()}`, session_id: 'system', ledger_session: ownerSid, system: true, caller: 'owner', cleanup: true };
    return this.#run(call, who, null, { system_cleanup: true });
  }

  /** Kill-switch fail-closed path: destroys every live worker the ledger knows, independent of any verifier. */
  async destroyWorkers(): Promise<{ destroyed: string[]; failed: { id: string; code: string }[] }> {
    const rows = this.d.db.prepare("SELECT id, session_id FROM resources WHERE destroyed_at_ms IS NULL AND class='instance' AND label LIKE 'plumbline-wk-%'").all() as { id: string; session_id: string }[];
    const out: { destroyed: string[]; failed: { id: string; code: string }[] } = { destroyed: [], failed: [] };
    for (const r of rows) {
      const res = await this.cleanup(r.session_id, 'instance', r.id);
      if (res.status === 'DECIDED' && !res.error && res.decision.decision === 'ALLOW') out.destroyed.push(r.id);
      else out.failed.push({ id: r.id, code: res.status === 'DECIDED' ? (res.error?.code ?? res.decision.rule_id) : res.status });
    }
    return out;
  }

  async #run(call: ParsedCall, who: Who, model: string | null, extraCall: Record<string, unknown> = {}): Promise<Outcome> {
    const d = await this.#evaluate(call, who);
    if ('refused' in d) return { status: 'ARGS_INVALID', errors: [d.refused] };
    if ('unavailable' in d) return { status: 'REWIND_UNAVAILABLE', message: String(d.unavailable) };
    const rec = this.#record(d, call, who, model, extraCall);
    const pub = this.#publicOf(d.decision, rec, model);
    if (d.decision.decision === 'DENY') return { status: 'DECIDED', decision: pub };
    if (d.decision.decision === 'ESCALATE') {
      const binding: Binding = { request_id: d.request.request_id, rule_id: d.decision.rule_id, request_hash: d.decision.request_hash, target_fp: fingerprint(d.resolved.target) };
      const nonce = this.d.approvals.create(rec.id, who.ledger_session, call, this.d.clock(), binding);
      return { status: 'DECIDED', decision: pub, approval: { nonce } };
    }
    return this.#execute(d.decision, d.request, call, who, pub, rec.id);
  }

  /**
   * AG4-BRK-5: an approval covers one escalation: the same rule, the same request hash and the same resolved target.
   * The re-evaluation writes no decision row, so an approval adds one ALLOW row (linked by approved_from) and no extra ESCALATE.
   */
  async approve(sid: string, decisionId: string, nonce: string, approve: boolean): Promise<ApproveOutcome> {
    const a = this.d.approvals.take(decisionId, sid, nonce, approve, this.d.clock());
    if (a.kind !== 'ok') return { status: a.kind === 'denied' ? 'DENIED' : a.kind === 'bad_nonce' ? 'BAD_NONCE' : 'NOT_FOUND' };
    const who: Who = { task_id: `appr-${short()}`, session_id: sid, ledger_session: sid, system: false, caller: 'owner' };
    const d = await this.#evaluate(a.call, who, a.binding.request_id);
    if ('refused' in d) return { status: 'ARGS_INVALID', errors: [d.refused] };
    if ('unavailable' in d) return { status: 'REWIND_UNAVAILABLE', message: String(d.unavailable) };
    const allow = this.#authorize(d, a.binding, nonce);
    if (!allow) {
      recordEvent(this.d.db, 'APPROVAL_STALE', sid, { decision_id: decisionId, was: a.binding.rule_id, now: d.decision.rule_id, now_decision: d.decision.decision }, this.d.clock());
      return { status: 'STALE' };
    }
    const rec = this.#record({ ...d, decision: allow }, a.call, who, null, { approved_from: decisionId });
    const pub = this.#publicOf(allow, rec, null);
    const bonded = this.d.config.bondEnabled && a.call.class === 'bucket_object' && a.call.verb === 'delete';
    if (bonded && !this.d.bond.hold(decisionId, this.d.config.bondBurnUsd)) {
      return { status: 'DECIDED', decision: { ...pub, decision: 'DENY', rule_id: 'bond-insufficient', reason: 'bond could not be held' } };
    }
    const out = await this.#execute(allow, d.request, a.call, who, pub, rec.id);
    if (bonded) {
      if (out.status === 'DECIDED' && !out.error) this.d.bond.burn(decisionId);
      else this.d.bond.release(decisionId);
    }
    return out;
  }

  #authorize(d: { decision: Decision; resolved: Resolved }, b: Binding, nonce: string): AllowDecision | null {
    const same = d.decision.decision === 'ESCALATE' && d.decision.rule_id === b.rule_id && d.decision.request_hash === b.request_hash && fingerprint(d.resolved.target) === b.target_fp;
    if (!same) return null;
    try {
      return this.d.authority.approve(d.decision as EscalateDecision, b, nonce);
    } catch (e) {
      if (e instanceof ApprovalError) return null;
      throw e;
    }
  }

  async #execute(allow: AllowDecision, req: CallRequest, call: ParsedCall, who: Who, pub: PublicDecision, decisionId: string): Promise<Outcome> {
    try {
      const result = await this.#dispatch(allow, req, call, who, decisionId);
      return { status: 'DECIDED', decision: pub, result };
    } catch (e) {
      return { status: 'DECIDED', decision: pub, error: this.#mapError(e, call.class) };
    }
  }

  #mapError(e: unknown, cls: ResourceClass): { code: string; message: string; body?: unknown } {
    if (e instanceof EgressRefused) return { code: e.code, message: e.message };
    if (e instanceof SpendRefused) return { code: 'SPEND_REFUSED', message: e.reason };
    if (e instanceof TierUnavailable) return { code: 'tier-key-unavailable', message: e.message };
    if (e instanceof VultrError) {
      if (e.status === 401) {
        for (const t of ['observer', 'deployer', 'network', 'registry'] as const) this.d.tiers.noteFailure(t, e);
        return { code: 'tier-key-unavailable', message: 'Vultr returned 401 (IP lock or expired key)' };
      }
      return { code: e.status === 429 ? 'VULTR_429' : e.status === 403 ? 'VULTR_403_ACL' : 'VULTR_ERROR', message: e.message, body: e.body };
    }
    return { code: cls === 'bucket_object' ? 'REWIND_UNAVAILABLE' : 'ERROR', message: String((e as Error).message ?? e).slice(0, 200) };
  }

  /** AG4-BRK-1: exhaustive on (class, verb). Anything not listed throws; there is no fall-through to a destructive branch. */
  async #dispatch(allow: AllowDecision, req: CallRequest, call: ParsedCall, who: Who, decisionId: string): Promise<unknown> {
    const sid = who.ledger_session;
    switch (`${call.class}:${call.verb}`) {
      case 'instance:list': case 'instance:create': case 'instance:update': case 'instance:delete':
        return this.#instance(allow, req, call, sid, decisionId);
      case 'firewall_group:list': case 'firewall_group:create': case 'firewall_group:update': case 'firewall_group:delete':
        return this.#firewall(allow, req, call, sid, decisionId);
      case 'vpc:list': case 'vpc:create': case 'vpc:delete':
        return this.#vpc(allow, req, call, sid, decisionId);
      case 'registry:list': case 'registry:create': case 'registry:delete':
        return this.#registry(allow, req, call, sid, decisionId);
      case 'bucket_object:list': case 'bucket_object:put': case 'bucket_object:restore': case 'bucket_object:delete':
        return this.#bucket(allow, req, call, sid);
      case 'http:fetch':
        return this.d.egress.fetch(call.params.url as string);
      case 'policy:read':
        return { text: this.d.policies.get(sid).text };
      case 'policy:write':
        return this.#policyWrite(call, who);
      case 'ledger:read':
        return this.d.ledger.display(sid);
      default:
        throw new Error(`DISPATCH_UNHANDLED: ${call.class}:${call.verb}`);
    }
  }

  /** AG4-BRK-7 (second line): the sandbox can never write a policy, whatever any policy layer says. */
  #policyWrite(call: ParsedCall, who: Who): unknown {
    if (who.caller !== 'owner') throw new Error('POLICY_WRITE_OWNER_ONLY');
    if (call.id === 'production') return { code: 'SIG_REQUIRED', message: 'production policy changes need a signed deploy' };
    return this.d.policies.put(who.ledger_session, call.params.content ?? '');
  }

  async #instance(allow: AllowDecision, req: CallRequest, call: ParsedCall, sid: string, decisionId: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, id, params } = call;
    const t = this.d.tiers;
    switch (verb) {
      case 'list':
        return new Instances(t.http('observer')).list(ctx);
      case 'create': {
        const label = req.params.label as string;
        const v = await new Instances(t.http('deployer')).create(allow, req);
        const hourly = this.d.rate.get()?.hourly[params.plan as string] ?? 0;
        this.d.ledger.recordResource({ id: v.id, class: 'instance', label: v.label || label, plan: params.plan as string, hourly, ttl_h: params.ttl_h ?? 1, protected: false, session_id: sid, allow_decision_id: decisionId });
        return v;
      }
      case 'update':
        return new Instances(t.http('deployer')).update(allow, req, { firewall_group_id: params.firewall_group_id as string });
      case 'delete':
        await new Instances(t.http('deployer')).delete(allow, req);
        this.d.ledger.markDestroyed(id as string);
        return { deleted: id };
      default:
        throw new Error(`DISPATCH_UNHANDLED: instance:${verb}`);
    }
  }

  async #firewall(allow: AllowDecision, req: CallRequest, call: ParsedCall, sid: string, decisionId: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, id, params, extra } = call;
    const fw = new Firewalls(this.d.tiers.http('network'));
    switch (verb) {
      case 'list':
        return fw.list(ctx);
      case 'create': {
        const label = req.params.label as string;
        const v = await fw.create(allow, req, { protectedTag: Boolean(extra.protectedPlayground) });
        this.d.ledger.recordResource({ id: v.id, class: 'firewall_group', label, plan: null, hourly: 0, ttl_h: 1, protected: Boolean(extra.protectedPlayground), session_id: extra.ownerSession ?? sid, allow_decision_id: decisionId });
        return v;
      }
      case 'update':
        return fw.addRule(allow, req, { port: params.port as string, notes: params.notes ?? 'plumbline' });
      case 'delete':
        await fw.delete(allow, req);
        this.d.ledger.markDestroyed(id as string);
        return { deleted: id };
      default:
        throw new Error(`DISPATCH_UNHANDLED: firewall_group:${verb}`);
    }
  }

  async #vpc(allow: AllowDecision, req: CallRequest, call: ParsedCall, sid: string, decisionId: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, id, extra } = call;
    if (verb === 'list') return new Vpcs(this.d.tiers.http('observer')).list(ctx);
    const vpc = new Vpcs(this.d.tiers.http('deployer'));
    if (verb === 'create') {
      const v = await vpc.create(allow, req);
      this.d.ledger.recordResource({ id: v.id, class: 'vpc', label: v.description, plan: null, hourly: 0, ttl_h: 1, protected: Boolean(extra.protectedPlayground), session_id: extra.ownerSession ?? sid, allow_decision_id: decisionId });
      return v;
    }
    if (verb !== 'delete') throw new Error(`DISPATCH_UNHANDLED: vpc:${verb}`);
    await vpc.delete(allow, req);
    this.d.ledger.markDestroyed(id as string);
    return { deleted: id };
  }

  async #registry(allow: AllowDecision, req: CallRequest, call: ParsedCall, sid: string, decisionId: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, id, params } = call;
    if (verb === 'list') return new Registries(this.d.tiers.http('observer')).list(ctx);
    const reg = new Registries(this.d.tiers.http('registry'));
    if (verb === 'create') {
      const v = await reg.create(allow, req);
      this.d.ledger.recordResource({ id: v.id, class: 'registry', label: v.name, plan: 'start_up', hourly: 0, ttl_h: 1, protected: false, session_id: sid, allow_decision_id: decisionId });
      return v;
    }
    if (verb !== 'delete') throw new Error(`DISPATCH_UNHANDLED: registry:${verb}`);
    await reg.delete(allow, req);
    this.d.ledger.markDestroyed(id as string);
    return { deleted: id };
  }

  async #bucket(allow: AllowDecision, req: CallRequest, call: ParsedCall, sid: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, id, params } = call;
    const key = id ?? canaryKeyFor(sid);
    switch (verb) {
      case 'list': return this.d.s3.listVersions(ctx, key);
      case 'put': return { version_id: await this.d.s3.putObject(allow, req, params.content ?? '{}') };
      case 'delete': return { delete_marker: await this.d.s3.deleteObject(allow, req) };
      case 'restore': return { version_id: await this.d.s3.restoreVersion(allow, req) };
      default: throw new Error(`DISPATCH_UNHANDLED: bucket_object:${verb}`);
    }
  }

  /** CO-E: gives a new session its own canary with two versions. The seeding puts are engine-judged, so they are in the ledger. */
  async seedCanary(sid: string): Promise<{ key: string; versions: number }> {
    const key = sessionCanaryKey(sid);
    const put = async (k: string, body: string): Promise<string> => {
      const out = await this.runSystem(sid, { verb: 'put', class: 'bucket_object', id: k, params: { content: body }, extra: {} });
      const ok = out.status === 'DECIDED' && out.decision.decision === 'ALLOW' && !out.error;
      if (!ok) throw new Error(`CANARY_SEED_REFUSED: ${out.status === 'DECIDED' ? (out.error?.code ?? out.decision.rule_id) : out.status}`);
      return String((out.result as { version_id?: string }).version_id ?? '');
    };
    const versionCount = async (k: string): Promise<number> => (await this.d.s3.listVersions({ session_id: sid }, k)).versions.length;
    const r = await ensureCanaryVersions({ versionCount, put }, sid);
    return { key, versions: r.versions };
  }

  callHash(raw: unknown): string {
    return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex');
  }
}
