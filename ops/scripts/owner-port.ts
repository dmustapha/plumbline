// File: ops/scripts/owner-port.ts
// G1h helper. One narrow, mockable door to the owner context (owner.ts, G1d) for gates.ts and teardown.ts.
// Every mutation goes through an engine ALLOW (owner caller) or a minted OwnerAction; this file holds no key and no hostname.
import { randomBytes } from 'node:crypto';
import type { AllowDecision, CallRequest, ResourceClass, Verb } from '@plumbline/policy-engine';
import { Firewalls, Instances, Registries, Vpcs, mintOwnerAction } from '@plumbline/vultr-adapter';
import type { Ctx, OwnerActionRecord, OwnerAdmin, VultrHttp } from '@plumbline/vultr-adapter';

export type Kind = 'instance' | 'firewall_group' | 'vpc' | 'registry' | 'user' | 'object_storage';
export interface Item { kind: Kind; id: string; label: string }

export interface OwnerPort {
  /** View-only: every plumbline-scoped resource, user and (when VULTR_OBJSTORE_ID is set) the storage subscription. */
  inventory(): Promise<Item[]>;
  createInstance(spec: { label: string; plan: string; region: string }): Promise<{ id: string }>;
  remove(item: Item, reason: string): Promise<void>;
}

/** What owner.ts (G1d) must return from ownerContext(). `allow` runs the engine under the owner policy and throws on non-ALLOW. */
export interface OwnerCtx {
  http: VultrHttp;
  admin: OwnerAdmin;
  ctx: Ctx;
  allow(req: CallRequest): AllowDecision;
  record(r: OwnerActionRecord): void;
}

const SCOPE = 'plumbline';
const inScope = (name: string): boolean => name.startsWith(SCOPE);

export function ownerRequest(verb: Verb, cls: ResourceClass, label: string, id?: string, params: CallRequest['params'] = {}): CallRequest {
  return {
    request_id: `owner-${randomBytes(6).toString('hex')}`, task_id: 'owner', session_id: 'owner', verb, class: cls,
    target: { id, label, tags: [], resolved: id !== undefined }, params: { label, ...params }, caller: 'owner',
  };
}

async function listInScope(o: OwnerCtx): Promise<Item[]> {
  const [inst, fw, vpc, reg, users] = await Promise.all([
    new Instances(o.http).list(o.ctx), new Firewalls(o.http).list(o.ctx), new Vpcs(o.http).list(o.ctx), new Registries(o.http).list(o.ctx), o.admin.listUsers(),
  ]);
  return [
    ...inst.map((i): Item => ({ kind: 'instance', id: i.id, label: i.label })),
    ...fw.map((f): Item => ({ kind: 'firewall_group', id: f.id, label: f.description })),
    ...vpc.map((v): Item => ({ kind: 'vpc', id: v.id, label: v.description })),
    ...reg.map((r): Item => ({ kind: 'registry', id: r.id, label: r.name })),
    ...users.map((u): Item => ({ kind: 'user', id: u.id, label: u.name })),
  ].filter((i) => inScope(i.label));
}

async function removeResource(o: OwnerCtx, item: Item): Promise<void> {
  const cls = item.kind as ResourceClass;
  const req = ownerRequest('delete', cls, item.label, item.id);
  const allow = o.allow(req);
  if (item.kind === 'instance') return new Instances(o.http).delete(allow, req);
  if (item.kind === 'firewall_group') return new Firewalls(o.http).delete(allow, req);
  if (item.kind === 'vpc') return new Vpcs(o.http).delete(allow, req);
  return new Registries(o.http).delete(allow, req);
}

export function makeOwnerPort(o: OwnerCtx, env: NodeJS.ProcessEnv = process.env): OwnerPort {
  return {
    async inventory() {
      const items = await listInScope(o);
      const sub = env.VULTR_OBJSTORE_ID;
      return sub ? [...items, { kind: 'object_storage', id: sub, label: `object-storage:${sub}` }] : items;
    },
    async createInstance(spec) {
      const req = ownerRequest('create', 'instance', spec.label, undefined, { plan: spec.plan, region: spec.region });
      const made = await new Instances(o.http).create(o.allow(req), req);
      return { id: made.id };
    },
    async remove(item, reason) {
      if (item.kind === 'user') return o.admin.deleteUser(mintOwnerAction('user.delete', reason, o.record), item.id);
      if (item.kind === 'object_storage') return o.admin.deleteObjectStorage(mintOwnerAction('objstore.delete', reason, o.record), item.id);
      return removeResource(o, item);
    },
  };
}

/** The only place that touches owner.ts and the owner key. A specifier variable keeps tsc independent of G1d's file. */
export async function loadOwnerPort(): Promise<OwnerPort> {
  const spec = './owner.ts';
  const mod = (await import(spec)) as { ownerContext?: () => OwnerCtx };
  if (typeof mod.ownerContext !== 'function') throw new Error('owner.ts must export ownerContext(): OwnerCtx (see evidence/change-requests.md, G1h)');
  return makeOwnerPort(mod.ownerContext());
}
