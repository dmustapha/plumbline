// File: packages/vultr-adapter/src/resources.ts
import type { AllowDecision, CallRequest } from '@plumbline/policy-engine';
import { guard, need, targetId } from './allow-guard.ts';
import { OutcomeUnknown, type VultrHttp } from './http.ts';

export const DEBIAN_12_OS_ID = 2136;

export interface Ctx {
  session_id: string;
}

export interface InstanceView {
  id: string;
  label: string;
  status: string;
  power_status: string;
  server_status: string;
  plan: string;
  region: string;
  tags: string[];
  date_created: string;
  firewall_group_id: string;
  main_ip: string;
}

export interface FirewallView {
  id: string;
  description: string;
  instance_count: number;
  rule_count: number;
  date_created: string;
}

export interface VpcView {
  id: string;
  description: string;
  region: string;
  date_created: string;
}

export interface RegistryView {
  id: string;
  name: string;
  urn: string;
  region: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function toInstance(r: Raw): InstanceView {
  return {
    id: str(r.id), label: str(r.label), status: str(r.status), power_status: str(r.power_status), server_status: str(r.server_status),
    plan: str(r.plan), region: str(r.region), tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(str) : [],
    date_created: str(r.date_created), firewall_group_id: str(r.firewall_group_id), main_ip: str(r.main_ip),
  };
}

export class Instances {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<InstanceView[]> {
    const res = await this.http.request<{ instances?: Raw[] }>('GET', '/instances', { ...ctx, query: { per_page: 500 } });
    return (res.instances ?? []).map(toInstance);
  }

  async get(ctx: Ctx, id: string): Promise<InstanceView> {
    const res = await this.http.request<{ instance: Raw }>('GET', `/instances/${encodeURIComponent(id)}`, ctx);
    return toInstance(res.instance);
  }

  /**
   * AG4-ADP-2: plan, region and label come ONLY from req.params (hash-bound by the engine), and the billed cost from the
   * same ALLOW, so a cheap decision cannot launch a costlier plan. `extra` fields cannot change cost.
   */
  async create(allow: AllowDecision, req: CallRequest, extra: { os_id?: number; firewall_group_id?: string; tags?: string[]; sshkey_ids?: string[] } = {}): Promise<InstanceView> {
    const ctx = guard(allow, req, 'create', 'instance');
    const label = need(req.params.label, 'label');
    const body: Raw = { region: need(req.params.region, 'region'), plan: need(req.params.plan, 'plan'), os_id: extra.os_id ?? DEBIAN_12_OS_ID, label, hostname: label, tags: extra.tags ?? ['plumbline'] };
    if (extra.firewall_group_id) body.firewall_group_id = extra.firewall_group_id;
    if (extra.sshkey_ids && extra.sshkey_ids.length > 0) body.sshkey_id = extra.sshkey_ids;
    const res = await this.http.request<{ instance?: Raw }>('POST', '/instances', { ...ctx, body, costUsd: allow.projected_cost_usd, request_id: req.request_id });
    if (!res?.instance) throw new OutcomeUnknown(req.request_id, 'POST', '/instances', ctx.session_id, 'accepted without an instance body', allow.projected_cost_usd);
    return toInstance(res.instance);
  }

  async update(allow: AllowDecision, req: CallRequest, patch: { firewall_group_id: string }): Promise<void> {
    const ctx = guard(allow, req, 'update', 'instance');
    await this.http.request('PATCH', `/instances/${encodeURIComponent(targetId(req))}`, { ...ctx, body: { firewall_group_id: patch.firewall_group_id }, request_id: req.request_id });
  }

  async delete(allow: AllowDecision, req: CallRequest): Promise<void> {
    const ctx = guard(allow, req, 'delete', 'instance');
    await this.http.request('DELETE', `/instances/${encodeURIComponent(targetId(req))}`, { ...ctx, request_id: req.request_id });
  }
}

export class Firewalls {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<FirewallView[]> {
    const res = await this.http.request<{ firewall_groups?: Raw[] }>('GET', '/firewalls', { ...ctx, query: { per_page: 500 } });
    return (res.firewall_groups ?? []).map((r) => ({
      id: str(r.id), description: str(r.description), instance_count: num(r.instance_count), rule_count: num(r.rule_count), date_created: str(r.date_created),
    }));
  }

  async create(allow: AllowDecision, req: CallRequest, opts: { protectedTag?: boolean } = {}): Promise<FirewallView> {
    const ctx = guard(allow, req, 'create', 'firewall_group');
    const label = need(req.params.label, 'label');
    const res = await this.http.request<{ firewall_group: Raw }>('POST', '/firewalls', { ...ctx, body: { description: opts.protectedTag ? `${label} [protected]` : label }, request_id: req.request_id });
    const r = res.firewall_group;
    return { id: str(r.id), description: str(r.description), instance_count: 0, rule_count: 0, date_created: str(r.date_created) };
  }

  /** The port must equal req.params.port: the broker puts it in params so the engine's request hash binds it (Params has no typed `port`). */
  async addRule(allow: AllowDecision, req: CallRequest, rule: { port: string; notes: string }): Promise<void> {
    const bound = (req.params as { port?: unknown }).port;
    if (typeof bound !== 'string' || bound !== rule.port) throw new Error('PORT_NOT_BOUND: rule port must equal the ALLOWed request params.port');
    const ctx = guard(allow, req, 'update', 'firewall_group');
    await this.http.request('POST', `/firewalls/${encodeURIComponent(targetId(req))}/rules`, {
      ...ctx, request_id: req.request_id, body: { ip_type: 'v4', protocol: 'tcp', subnet: '0.0.0.0', subnet_size: 0, port: rule.port, notes: rule.notes },
    });
  }

  async delete(allow: AllowDecision, req: CallRequest): Promise<void> {
    const ctx = guard(allow, req, 'delete', 'firewall_group');
    await this.http.request('DELETE', `/firewalls/${encodeURIComponent(targetId(req))}`, { ...ctx, request_id: req.request_id });
  }
}

export class Vpcs {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<VpcView[]> {
    const res = await this.http.request<{ vpcs?: Raw[] }>('GET', '/vpcs', { ...ctx, query: { per_page: 500 } });
    return (res.vpcs ?? []).map((r) => ({ id: str(r.id), description: str(r.description), region: str(r.region), date_created: str(r.date_created) }));
  }

  async create(allow: AllowDecision, req: CallRequest): Promise<VpcView> {
    const ctx = guard(allow, req, 'create', 'vpc');
    const body = { region: need(req.params.region, 'region'), description: need(req.params.label, 'label'), v4_subnet: need(req.params.subnet, 'subnet'), v4_subnet_size: Number(need(req.params.subnet_size, 'subnet_size')) };
    const res = await this.http.request<{ vpc: Raw }>('POST', '/vpcs', { ...ctx, body, request_id: req.request_id });
    const r = res.vpc;
    return { id: str(r.id), description: str(r.description), region: str(r.region), date_created: str(r.date_created) };
  }

  async delete(allow: AllowDecision, req: CallRequest): Promise<void> {
    const ctx = guard(allow, req, 'delete', 'vpc');
    await this.http.request('DELETE', `/vpcs/${encodeURIComponent(targetId(req))}`, { ...ctx, request_id: req.request_id });
  }
}

export class Registries {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<RegistryView[]> {
    const res = await this.http.request<{ registries?: Raw[] }>('GET', '/registries', ctx);
    return (res.registries ?? []).map((r) => ({ id: str(r.id), name: str(r.name), urn: str(r.urn), region: str(r.region) }));
  }

  async create(allow: AllowDecision, req: CallRequest): Promise<RegistryView> {
    const name = need(req.params.name, 'name');
    if (!/^[a-z0-9]{3,40}$/.test(name)) throw new Error('registry name must be lowercase alphanumeric (KP-P6: hyphen returns 422)');
    const ctx = guard(allow, req, 'create', 'registry');
    const res = await this.http.request<Raw>('POST', '/registry', { ...ctx, body: { name, public: false, region: need(req.params.region, 'region'), plan: 'start_up' }, request_id: req.request_id });
    const r = (res.registry as Raw | undefined) ?? res;
    return { id: str(r.id), name: str(r.name), urn: str(r.urn), region: str(r.region) };
  }

  async delete(allow: AllowDecision, req: CallRequest): Promise<void> {
    const ctx = guard(allow, req, 'delete', 'registry');
    await this.http.request('DELETE', `/registry/${encodeURIComponent(targetId(req))}`, { ...ctx, request_id: req.request_id });
  }
}
