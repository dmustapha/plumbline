// File: apps/broker/src/pipeline.ts
import { randomBytes, createHash } from 'node:crypto';
import {
  approveEscalation, evaluate, type AllowDecision, type CallRequest, type Decision, type Params,
  type PolicyDoc, type ResourceClass, type Target, type Verb,
} from '@plumbline/policy-engine';
import { recordDecision, recordEvent, type Bond, type Db, type Ledger } from '@plumbline/ledger';
import {
  Firewalls, Instances, Registries, SpendRefused, TierUnavailable, VultrError, Vpcs, type RateCardCache, type S3Store, type TierKeys,
} from '@plumbline/vultr-adapter';
import type { Config } from './config.ts';
import type { Approvals } from './approvals.ts';
import type { Egress } from './egress.ts';
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
  egress: Egress;
  clock: () => number;
}

export interface Extra {
  content?: string;
  port?: string;
  notes?: string;
  firewall_group_id?: string;
  protectedPlayground?: boolean;
  ownerSession?: string;
}

export interface ParsedCall {
  verb: Verb;
  class: ResourceClass;
  id?: string;
  params: Params;
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

const PARAM_KEYS = new Set(['plan', 'region', 'ttl_h', 'label', 'url', 'key', 'version_id', 'name', 'subnet', 'subnet_size', 'content', 'port', 'notes', 'firewall_group_id']);
const SAFE = /^[A-Za-z0-9._:/-]{1,128}$/;
const LABEL = /^[A-Za-z0-9._-]{1,63}$/;

export function parseCall(raw: unknown): { ok: true; call: ParsedCall } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['body must be an object'] };
  const o = raw as Record<string, unknown>;
  if (typeof o.verb !== 'string' || o.verb.length > 16) errors.push('verb must be a short string');
  if (typeof o.class !== 'string' || o.class.length > 24) errors.push('class must be a short string');
  const params: Params = {};
  const extra: Extra = {};
  const p = o.params ?? {};
  if (typeof p !== 'object' || p === null || Array.isArray(p)) errors.push('params must be an object');
  else {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!PARAM_KEYS.has(k)) { errors.push(`unknown param "${k}"`); continue; }
      if (k === 'ttl_h' || k === 'subnet_size') {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 744) errors.push(`${k} must be a number in (0, 744]`);
        else (params as Record<string, unknown>)[k] = v;
      } else if (typeof v !== 'string' || v.length > (k === 'content' ? 2000 : 512)) errors.push(`${k} must be a string`);
      else if (k === 'content') extra.content = v;
      else if (k === 'port') extra.port = v;
      else if (k === 'notes') extra.notes = v;
      else if (k === 'firewall_group_id') extra.firewall_group_id = v;
      else if (k === 'label' && !LABEL.test(v)) errors.push('label has illegal characters');
      else if (k !== 'url' && k !== 'label' && !SAFE.test(v)) errors.push(`${k} has illegal characters`);
      else (params as Record<string, unknown>)[k] = v;
    }
  }
  let id: string | undefined;
  const t = o.target;
  if (t !== undefined && (typeof t !== 'object' || t === null || Array.isArray(t))) errors.push('target must be an object');
  else if (t && typeof (t as Record<string, unknown>).id === 'string') {
    const tid = (t as { id: string }).id;
    if (!SAFE.test(tid)) errors.push('target.id has illegal characters');
    else id = tid;
  }
  const verb = o.verb as Verb;
  const cls = o.class as ResourceClass;
  const needsId = ['update', 'delete', 'restore'].includes(verb) || (verb === 'put' && cls === 'bucket_object');
  if (needsId && !id && cls !== 'policy') errors.push('target.id is required for this verb');
  if (verb === 'create' && cls === 'instance' && (!params.plan || !params.region)) errors.push('create instance needs plan and region');
  if (verb === 'create' && cls === 'vpc' && (!params.region || !params.subnet || !params.subnet_size)) errors.push('create vpc needs region, subnet, subnet_size');
  if (verb === 'create' && cls === 'registry' && (!params.name || !params.region)) errors.push('create registry needs name and region');
  if (verb === 'restore' && !params.version_id) errors.push('restore needs params.version_id');
  if (verb === 'fetch' && !params.url) errors.push('fetch needs params.url');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, call: { verb, class: cls, id, params, extra } };
}

interface Resolved {
  target: Target;
  versions: number | null;
}

const hasMarker = (s: string): boolean => s.toLowerCase().includes('[protected]');
const short = (): string => randomBytes(3).toString('hex');

export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  async #resolve(call: ParsedCall, sid: string, taskId: string): Promise<Resolved | { unavailable: string }> {
    const ctx = { session_id: sid };
    const { verb, class: cls, id, params } = call;
    if (cls === 'bucket_object') {
      const key = id ?? 'orders.json';
      if (verb === 'delete' || verb === 'restore') {
        try {
          const l = await this.d.s3.listVersions(ctx, key);
          return { target: { id: key, label: this.d.config.bucket, tags: [] }, versions: l.versions.length };
        } catch (e) {
          return { unavailable: String((e as Error).message) };
        }
      }
      return { target: { id: key, label: this.d.config.bucket, tags: [] }, versions: null };
    }
    if (verb === 'create') {
      const label = params.label ?? params.name ?? (cls === 'instance' ? `plumbline-wk-${taskId.slice(0, 4)}${short()}` : undefined);
      return { target: { label }, versions: null };
    }
    if (!id || !['instance', 'firewall_group', 'vpc', 'registry'].includes(cls) || verb === 'list') return { target: { id }, versions: null };
    try {
      return { target: await this.#lookup(cls, id, ctx), versions: null };
    } catch {
      return { target: { id }, versions: null };
    }
  }

  async #lookup(cls: ResourceClass, id: string, ctx: { session_id: string }): Promise<Target> {
    if (cls === 'instance') {
      const found = (await new Instances(this.d.tiers.http('observer')).list(ctx)).find((i) => i.id === id);
      return found ? { id, label: found.label, tags: found.tags } : { id };
    }
    if (cls === 'firewall_group') {
      const found = (await new Firewalls(this.d.tiers.http('network')).list(ctx)).find((f) => f.id === id);
      return found ? { id, label: found.description, tags: hasMarker(found.description) ? ['protected'] : [] } : { id };
    }
    if (cls === 'vpc') {
      const found = (await new Vpcs(this.d.tiers.http('observer')).list(ctx)).find((v) => v.id === id);
      return found ? { id, label: found.description, tags: hasMarker(found.description) ? ['protected'] : [] } : { id };
    }
    const found = (await new Registries(this.d.tiers.http('observer')).list(ctx)).find((r) => r.id === id);
    return found ? { id, label: found.name, tags: [] } : { id };
  }

  async #decide(call: ParsedCall, who: { task_id: string; session_id: string; ledger_session: string; system: boolean }, model: string | null) {
    const resolved = await this.#resolve(call, who.ledger_session, who.task_id);
    if ('unavailable' in resolved) return { unavailable: resolved.unavailable } as const;
    const request: CallRequest = {
      request_id: `q-${randomBytes(6).toString('hex')}`, task_id: who.task_id, session_id: who.session_id,
      verb: call.verb, class: call.class, target: resolved.target, params: call.params,
    };
    const policy: PolicyDoc = who.system ? this.d.policies.systemDoc : this.d.policies.get(who.ledger_session).doc;
    const state = buildState({ ...this.d, kill: this.d.kill, bond: this.d.bond }, who.ledger_session, { versions: resolved.versions });
    const decision = evaluate(request, policy, this.d.policies.floor, state);
    const quoted = { verb: call.verb, class: call.class, id: call.id ?? null, params: call.params };
    const rec = recordDecision(this.d.db, decision, { session_id: who.session_id, task_id: who.task_id, model, call: quoted, vultr_ids: call.id ? [call.id] : [] }, this.d.clock());
    return { decision, request, rec, resolved } as const;
  }

  #publicOf(d: Decision, rec: { id: string; ts: number }, model: string | null): PublicDecision {
    return {
      decision_id: rec.id, ts: rec.ts, decision: d.decision, rule_id: d.rule_id, layer: d.layer, reason: d.reason,
      layers: d.layers, policy_version: d.policy_version, projected_cost_usd: d.projected_cost_usd, model,
    };
  }

  async handleCall(claims: { task_id: string; session_id: string }, raw: unknown, model: string | null = null): Promise<Outcome> {
    const parsed = parseCall(raw);
    if (!parsed.ok) {
      recordEvent(this.d.db, 'ARGS_INVALID', claims.session_id, { errors: parsed.errors });
      return { status: 'ARGS_INVALID', errors: parsed.errors };
    }
    return this.#run(parsed.call, { task_id: claims.task_id, session_id: claims.session_id, ledger_session: claims.session_id, system: false }, model);
  }

  async runSystem(sid: string, call: ParsedCall): Promise<Outcome> {
    return this.#run(call, { task_id: `sys-${short()}`, session_id: 'system', ledger_session: sid, system: true }, null);
  }

  async #run(call: ParsedCall, who: { task_id: string; session_id: string; ledger_session: string; system: boolean }, model: string | null): Promise<Outcome> {
    const d = await this.#decide(call, who, model);
    if ('unavailable' in d) return { status: 'REWIND_UNAVAILABLE', message: String(d.unavailable) };
    const pub = this.#publicOf(d.decision, d.rec, model);
    if (d.decision.decision === 'DENY') return { status: 'DECIDED', decision: pub };
    if (d.decision.decision === 'ESCALATE') {
      const nonce = this.d.approvals.create(d.rec.id, who.ledger_session, call, this.d.clock());
      return { status: 'DECIDED', decision: pub, approval: { nonce } };
    }
    return this.#execute(d.decision, call, who.ledger_session, pub, d.resolved.target, d.rec.id);
  }

  async approve(sid: string, decisionId: string, nonce: string, approve: boolean): Promise<Outcome | { status: 'NOT_FOUND' | 'DENIED' | 'STALE' | 'BAD_NONCE' }> {
    const a = this.d.approvals.take(decisionId, sid, nonce, approve, this.d.clock());
    if (a.kind !== 'ok') return { status: a.kind === 'denied' ? 'DENIED' : a.kind === 'bad_nonce' ? 'BAD_NONCE' : 'NOT_FOUND' };
    const who = { task_id: `appr-${short()}`, session_id: sid, ledger_session: sid, system: false };
    const d = await this.#decide(a.call, who, null);
    if ('unavailable' in d) return { status: 'REWIND_UNAVAILABLE', message: String(d.unavailable) };
    if (d.decision.decision !== 'ESCALATE') return { status: 'STALE' };
    const allow = approveEscalation(d.decision);
    const rec = recordDecision(this.d.db, allow, { session_id: sid, task_id: who.task_id, model: null, call: { approved_from: decisionId, ...a.call }, vultr_ids: a.call.id ? [a.call.id] : [] }, this.d.clock());
    const actionId = `${decisionId}`;
    const bonded = this.d.config.bondEnabled && a.call.class === 'bucket_object' && a.call.verb === 'delete';
    if (bonded && !this.d.bond.hold(actionId, this.d.config.bondBurnUsd)) {
      return { status: 'DECIDED', decision: { ...this.#publicOf(allow, rec, null), decision: 'DENY', rule_id: 'bond-insufficient', reason: 'bond could not be held' } };
    }
    const out = await this.#execute(allow, a.call, sid, this.#publicOf(allow, rec, null), d.resolved.target, rec.id);
    if (bonded) {
      const ok = out.status === 'DECIDED' && !out.error;
      if (ok) this.d.bond.burn(actionId);
      else this.d.bond.release(actionId);
    }
    return out;
  }

  async #execute(allow: AllowDecision, call: ParsedCall, sid: string, pub: PublicDecision, target: Target, decisionId: string): Promise<Outcome> {
    try {
      const result = await this.#dispatch(allow, call, sid, target, decisionId);
      return { status: 'DECIDED', decision: pub, result };
    } catch (e) {
      return { status: 'DECIDED', decision: pub, error: this.#mapError(e, call.class) };
    }
  }

  #mapError(e: unknown, cls: ResourceClass): { code: string; message: string; body?: unknown } {
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

  async #dispatch(allow: AllowDecision, call: ParsedCall, sid: string, target: Target, decisionId: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, class: cls, id, params, extra } = call;
    const t = this.d.tiers;
    if (cls === 'instance') {
      if (verb === 'list') return new Instances(t.http('observer')).list(ctx);
      if (verb === 'create') {
        const v = await new Instances(t.http('deployer')).create(allow, ctx, { region: params.region as string, plan: params.plan as string, label: target.label as string });
        const hourly = this.d.rate.get()?.hourly[params.plan as string] ?? 0;
        this.d.ledger.recordResource({ id: v.id, class: 'instance', label: v.label || (target.label as string), plan: params.plan as string, hourly, ttl_h: params.ttl_h ?? 1, protected: false, session_id: sid, allow_decision_id: decisionId });
        return v;
      }
      if (verb === 'update') return new Instances(t.http('deployer')).update(allow, ctx, id as string, { firewall_group_id: extra.firewall_group_id ?? '' });
      await new Instances(t.http('deployer')).delete(allow, ctx, id as string);
      this.d.ledger.markDestroyed(id as string);
      return { deleted: id };
    }
    if (cls === 'firewall_group') {
      const fw = new Firewalls(t.http('network'));
      if (verb === 'list') return fw.list(ctx);
      if (verb === 'create') {
        const label = target.label as string;
        const v = await fw.create(allow, ctx, { description: extra.protectedPlayground ? `${label} [protected]` : label });
        this.d.ledger.recordResource({ id: v.id, class: 'firewall_group', label, plan: null, hourly: 0, ttl_h: 1, protected: Boolean(extra.protectedPlayground), session_id: extra.ownerSession ?? sid, allow_decision_id: decisionId });
        return v;
      }
      if (verb === 'update') return fw.addRule(allow, ctx, id as string, { port: extra.port ?? '22', notes: extra.notes ?? 'plumbline' });
      await fw.delete(allow, ctx, id as string);
      this.d.ledger.markDestroyed(id as string);
      return { deleted: id };
    }
    if (cls === 'vpc') {
      if (verb === 'list') return new Vpcs(t.http('observer')).list(ctx);
      const vpc = new Vpcs(t.http('deployer'));
      if (verb === 'create') {
        const v = await vpc.create(allow, ctx, { region: params.region as string, description: target.label ?? `plumbline-vpc-${short()}`, v4_subnet: params.subnet as string, v4_subnet_size: params.subnet_size as number });
        this.d.ledger.recordResource({ id: v.id, class: 'vpc', label: v.description, plan: null, hourly: 0, ttl_h: 1, protected: false, session_id: sid, allow_decision_id: decisionId });
        return v;
      }
      await vpc.delete(allow, ctx, id as string);
      this.d.ledger.markDestroyed(id as string);
      return { deleted: id };
    }
    if (cls === 'registry') {
      if (verb === 'list') return new Registries(t.http('observer')).list(ctx);
      const reg = new Registries(t.http('registry'));
      if (verb === 'create') {
        const v = await reg.create(allow, ctx, { name: params.name as string, region: params.region as string });
        this.d.ledger.recordResource({ id: v.id, class: 'registry', label: v.name, plan: 'start_up', hourly: 0, ttl_h: 1, protected: false, session_id: sid, allow_decision_id: decisionId });
        return v;
      }
      await reg.delete(allow, ctx, id as string);
      this.d.ledger.markDestroyed(id as string);
      return { deleted: id };
    }
    return this.#dispatchOther(allow, call, sid);
  }

  async #dispatchOther(allow: AllowDecision, call: ParsedCall, sid: string): Promise<unknown> {
    const ctx = { session_id: sid };
    const { verb, class: cls, id, params, extra } = call;
    if (cls === 'bucket_object') {
      const key = id ?? 'orders.json';
      if (verb === 'list') return this.d.s3.listVersions(ctx, key);
      if (verb === 'put') return { version_id: await this.d.s3.putObject(allow, ctx, key, extra.content ?? '{}') };
      if (verb === 'delete') return { delete_marker: await this.d.s3.deleteObject(allow, ctx, key) };
      return { version_id: await this.d.s3.restoreVersion(allow, ctx, key, params.version_id as string) };
    }
    if (cls === 'http') return this.d.egress.fetch(params.url as string);
    if (cls === 'policy') {
      if (verb === 'read') return { text: this.d.policies.get(sid).text };
      if (id === 'production') return { code: 'SIG_REQUIRED', message: 'production policy changes need a signed deploy' };
      return this.d.policies.put(sid, extra.content ?? '');
    }
    return this.d.ledger.display(sid);
  }

  callHash(raw: unknown): string {
    return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex');
  }
}
