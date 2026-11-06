// File: packages/vultr-adapter/src/resources.ts
import { assertAllow, type AllowDecision, type ResourceClass, type Verb } from '@plumbline/policy-engine';
import type { VultrHttp } from './http.ts';

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

function guard(allow: AllowDecision, verb: Verb, cls: ResourceClass): void {
  assertAllow(allow);
  if (allow.verb !== verb || allow.class !== cls) throw new Error(`ALLOW_MISMATCH: ${allow.verb} ${allow.class} != ${verb} ${cls}`);
}

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

  async create(allow: AllowDecision, ctx: Ctx, input: { region: string; plan: string; label: string; os_id?: number; firewall_group_id?: string; tags?: string[]; sshkey_ids?: string[] }): Promise<InstanceView> {
    guard(allow, 'create', 'instance');
    const body: Raw = { region: input.region, plan: input.plan, os_id: input.os_id ?? DEBIAN_12_OS_ID, label: input.label, hostname: input.label, tags: input.tags ?? ['plumbline'] };
    if (input.firewall_group_id) body.firewall_group_id = input.firewall_group_id;
    if (input.sshkey_ids && input.sshkey_ids.length > 0) body.sshkey_id = input.sshkey_ids;
    const res = await this.http.request<{ instance: Raw }>('POST', '/instances', { ...ctx, body, costUsd: allow.projected_cost_usd });
    return toInstance(res.instance);
  }

  async update(allow: AllowDecision, ctx: Ctx, id: string, patch: { firewall_group_id: string }): Promise<void> {
    guard(allow, 'update', 'instance');
    await this.http.request('PATCH', `/instances/${encodeURIComponent(id)}`, { ...ctx, body: { firewall_group_id: patch.firewall_group_id } });
  }

  async delete(allow: AllowDecision, ctx: Ctx, id: string): Promise<void> {
    guard(allow, 'delete', 'instance');
    await this.http.request('DELETE', `/instances/${encodeURIComponent(id)}`, ctx);
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

  async create(allow: AllowDecision, ctx: Ctx, input: { description: string }): Promise<FirewallView> {
    guard(allow, 'create', 'firewall_group');
    const res = await this.http.request<{ firewall_group: Raw }>('POST', '/firewalls', { ...ctx, body: { description: input.description } });
    const r = res.firewall_group;
    return { id: str(r.id), description: str(r.description), instance_count: 0, rule_count: 0, date_created: str(r.date_created) };
  }

  async addRule(allow: AllowDecision, ctx: Ctx, id: string, rule: { port: string; notes: string }): Promise<void> {
    guard(allow, 'update', 'firewall_group');
    await this.http.request('POST', `/firewalls/${encodeURIComponent(id)}/rules`, {
      ...ctx, body: { ip_type: 'v4', protocol: 'tcp', subnet: '0.0.0.0', subnet_size: 0, port: rule.port, notes: rule.notes },
    });
  }

  async delete(allow: AllowDecision, ctx: Ctx, id: string): Promise<void> {
    guard(allow, 'delete', 'firewall_group');
    await this.http.request('DELETE', `/firewalls/${encodeURIComponent(id)}`, ctx);
  }
}

export class Vpcs {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<VpcView[]> {
    const res = await this.http.request<{ vpcs?: Raw[] }>('GET', '/vpcs', { ...ctx, query: { per_page: 500 } });
    return (res.vpcs ?? []).map((r) => ({ id: str(r.id), description: str(r.description), region: str(r.region), date_created: str(r.date_created) }));
  }

  async create(allow: AllowDecision, ctx: Ctx, input: { region: string; description: string; v4_subnet: string; v4_subnet_size: number }): Promise<VpcView> {
    guard(allow, 'create', 'vpc');
    const res = await this.http.request<{ vpc: Raw }>('POST', '/vpcs', { ...ctx, body: input });
    const r = res.vpc;
    return { id: str(r.id), description: str(r.description), region: str(r.region), date_created: str(r.date_created) };
  }

  async delete(allow: AllowDecision, ctx: Ctx, id: string): Promise<void> {
    guard(allow, 'delete', 'vpc');
    await this.http.request('DELETE', `/vpcs/${encodeURIComponent(id)}`, ctx);
  }
}

export class Registries {
  constructor(private readonly http: VultrHttp) {}

  async list(ctx: Ctx): Promise<RegistryView[]> {
    const res = await this.http.request<{ registries?: Raw[] }>('GET', '/registries', ctx);
    return (res.registries ?? []).map((r) => ({ id: str(r.id), name: str(r.name), urn: str(r.urn), region: str(r.region) }));
  }

  async create(allow: AllowDecision, ctx: Ctx, input: { name: string; region: string }): Promise<RegistryView> {
    guard(allow, 'create', 'registry');
    if (!/^[a-z0-9]{3,40}$/.test(input.name)) throw new Error('registry name must be lowercase alphanumeric (KP-P6: hyphen returns 422)');
    const res = await this.http.request<Raw>('POST', '/registry', { ...ctx, body: { name: input.name, public: false, region: input.region, plan: 'start_up' } });
    const r = (res.registry as Raw | undefined) ?? res;
    return { id: str(r.id), name: str(r.name), urn: str(r.urn), region: str(r.region) };
  }

  async delete(allow: AllowDecision, ctx: Ctx, id: string): Promise<void> {
    guard(allow, 'delete', 'registry');
    await this.http.request('DELETE', `/registry/${encodeURIComponent(id)}`, ctx);
  }
}
