// L3 watchdog (G1c): scoped dead-hand deletes, fail-closed lease, dry-run, baseline protection. Mock Vultr only: no live resource, no real key.
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Instances, OutcomeUnknown, VultrHttp, resetSharedLimiter, TIER_ACL } from '@plumbline/vultr-adapter';
import { loadWatchdogConfig } from '../src/config.ts';
import { readDestroyed } from '../src/sharedFiles.ts';
import { CallBudgetGate } from '../src/vultr-lite.ts';
import {
  ACTIONS_FILE, ActionsLog, STATUS_FILE, Watchdog, assertOwnUser, assertWatchdogKey, decideDelete, diagnoseLease, inDeadHandScope, resolveDryRun, watchdogPolicy,
  type Target,
} from '../src/watchdog.ts';
import { FLOOR, T } from './support.ts';

const MY_UID = process.getuid?.() ?? 1000;
const GOOD = 'plumbline-s0123abcd-playground';

interface Item { id: string; label: string; tags?: string[] }
interface Fake {
  instances: Item[]; vpcs: Item[]; firewalls: Item[];
  calls: string[]; deletes: string[]; sleeps: number[];
  /** statuses returned (in order) before DELETE behaves normally; `500x` also removes the resource (the provider accepted it) */
  deleteScript: (number | '500x')[]; listScript: number[]; accountAcls: string[] | 'forbidden' | 'no-acls';
}

function fake(): { f: Fake; http: VultrHttp } {
  const f: Fake = { instances: [], vpcs: [], firewalls: [], calls: [], deletes: [], sleeps: [], deleteScript: [], listScript: [], accountAcls: [TIER_ACL.deployer, TIER_ACL.network] };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname.replace('/v2', '');
    const method = init?.method ?? 'GET';
    f.calls.push(`${method} ${path}`);
    if (path === '/account') return f.accountAcls === 'forbidden' ? json(403, { error: 'no' }) : json(200, { account: f.accountAcls === 'no-acls' ? {} : { acls: f.accountAcls } });
    if (method === 'GET') return listResponse(f, path, json);
    return deleteResponse(f, path, json);
  }) as unknown as typeof fetch;
  const http = new VultrHttp({ apiKey: 'wd-key', gate: new CallBudgetGate(), fetchImpl, sleep: async (ms) => { f.sleeps.push(ms); } });
  return { f, http };
}

function listResponse(f: Fake, path: string, json: (s: number, b: unknown, h?: Record<string, string>) => Response): Response {
  const status = f.listScript.shift();
  if (status && status !== 200) return json(status, { error: 'scripted' }, { 'retry-after': '1' });
  if (path === '/instances') return json(200, { instances: f.instances.map((i) => ({ id: i.id, label: i.label, tags: i.tags ?? [], status: 'active', plan: 'vc2-1c-1gb', region: 'ewr' })) });
  if (path === '/vpcs') return json(200, { vpcs: f.vpcs.map((v) => ({ id: v.id, description: v.label, region: 'ewr' })) });
  if (path === '/firewalls') return json(200, { firewall_groups: f.firewalls.map((g) => ({ id: g.id, description: g.label })) });
  return json(404, {});
}

function deleteResponse(f: Fake, path: string, json: (s: number, b: unknown, h?: Record<string, string>) => Response): Response {
  const [, kind, id] = path.split('/') as [string, string, string];
  const list = kind === 'instances' ? f.instances : kind === 'vpcs' ? f.vpcs : f.firewalls;
  const scripted = f.deleteScript.shift();
  const remove = (): void => { const at = list.findIndex((x) => x.id === id); if (at >= 0) list.splice(at, 1); f.deletes.push(id); };
  if (scripted === '500x') { remove(); return json(500, { error: 'boom' }); }
  if (typeof scripted === 'number') return json(scripted, { error: 'scripted' }, { 'retry-after': '2' });
  remove();
  return json(204, null);
}

interface Rig { dir: string; clock: { now: number }; f: Fake; http: VultrHttp; dog: Watchdog }

function rig(over: { dryRun?: boolean; baseline?: ReadonlySet<string> | null; verifierUid?: number | null; graceMs?: number } = {}): Rig {
  resetSharedLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'plb-wd-'));
  chmodSync(dir, 0o770);
  const { f, http } = fake();
  const clock = { now: T };
  const baseline = over.baseline === undefined ? new Set<string>() : over.baseline;
  const dog = new Watchdog({
    http, floor: FLOOR, sharedDir: dir, dryRun: over.dryRun ?? false, verifierUid: over.verifierUid === undefined ? MY_UID : over.verifierUid,
    leaseGraceMs: over.graceMs ?? 120_000, baselineIds: () => baseline, clock: () => clock.now,
  });
  return { dir, clock, f, http, dog };
}

function writeLease(dir: string, body: unknown, mode = 0o640): void {
  const p = join(dir, 'lease.json');
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(p, mode);
}
const lapsed = (r: Rig): void => writeLease(r.dir, { last_ts: T - 200_000, ttl_s: 45, received_at: T - 100_000 });
const alive = (r: Rig): void => writeLease(r.dir, { last_ts: T, ttl_s: 45, received_at: T - 1000 });
const status = (r: Rig): Record<string, unknown> => JSON.parse(readFileSync(join(r.dir, STATUS_FILE), 'utf8')) as Record<string, unknown>;

/** a fleet with every kind of thing the watchdog must or must not touch */
function stock(f: Fake): void {
  f.instances.push(
    { id: 'i-wk1', label: 'plumbline-wk-1' }, { id: 'i-wk2', label: 'plumbline-wk-2' },
    { id: 'i-broker', label: 'plumbline-infra-broker' }, { id: 'i-verifier', label: 'plumbline-infra-verifier' }, { id: 'i-prod', label: 'plumbline-prod-db' },
    { id: 'i-other', label: 'someone-elses-box' }, { id: 'i-wkprot', label: 'plumbline-wk-9', tags: ['protected'] },
  );
  f.vpcs.push({ id: 'v-play', label: GOOD }, { id: 'v-infra', label: 'plumbline-infra-vpc' }, { id: 'v-shared', label: 'plumbline-shared' });
  f.firewalls.push({ id: 'g-play', label: 'plumbline-s89abcdef-fw' }, { id: 'g-infra', label: 'plumbline-infra-fw' }, { id: 'g-sandbox', label: 'plumbline-sandbox-x' });
}
const SURVIVORS = ['i-broker', 'i-verifier', 'i-prod', 'i-other', 'i-wkprot', 'v-infra', 'v-shared', 'g-infra', 'g-sandbox'];

describe('inDeadHandScope (AG4-VER-5: the strict playground regex, never the bare prefix)', () => {
  it.each([
    ['instance', 'plumbline-wk-1', true], ['instance', 'plumbline-wk-abc-9', true], ['vpc', GOOD, true], ['firewall_group', 'plumbline-s0123abcd-a', true],
  ] as const)('in scope: %s %s', (cls, label, want) => expect(inDeadHandScope(cls, label)).toBe(want));

  it.each([
    ['instance', 'plumbline-wk-'], ['instance', 'plumbline-infra-broker'], ['instance', 'plumbline-prod-db'], ['instance', 'plumbline-s0123abcd-a'], ['instance', 'xplumbline-wk-1'],
    ['firewall_group', 'plumbline-shared'], ['firewall_group', 'plumbline-sandbox-x'], ['firewall_group', 'plumbline-ssh-infra'], ['firewall_group', 'plumbline-s0123abcd'],
    ['firewall_group', 'plumbline-s0123ABCD-x'], ['firewall_group', 'plumbline-s0123abc-x'], ['firewall_group', 'plumbline-s0123abcd-x [protected]'],
    ['vpc', 'plumbline-s0123abcd-x\n'], ['vpc', 'plumbline-infra-vpc'], ['vpc', 'plumbline-wk-1'], ['registry', 'plumblinereg'], ['registry', GOOD], ['bucket_object', GOOD],
  ] as const)('out of scope: %s %s', (cls, label) => expect(inDeadHandScope(cls, label)).toBe(false));
});

describe('decideDelete (AG4-VER-5, DT-21): the engine is a second layer even if the scope filter were wrong', () => {
  const policy = watchdogPolicy();
  const decide = (cls: Target['cls'], label: string, tags: string[] = []) => decideDelete({ id: 'x', label, tags, cls }, policy, FLOOR, T, 1).decision;

  it('ALLOWs a worker and a well-formed playground', () => {
    expect(decide('instance', 'plumbline-wk-1').decision).toBe('ALLOW');
    expect(decide('vpc', GOOD).decision).toBe('ALLOW');
    expect(decide('firewall_group', 'plumbline-s0123abcd-fw').decision).toBe('ALLOW');
  });
  it.each([
    ['instance', 'plumbline-infra-broker', 'floor-prod-immutable'], ['instance', 'plumbline-prod-db', 'floor-prod-immutable'],
    ['vpc', 'plumbline-infra-vpc', 'floor-prod-immutable'], ['firewall_group', 'plumbline-infra-fw', 'floor-prod-immutable'],
    ['registry', 'plumblinereg', 'floor-registry-shared'], ['firewall_group', 'plumbline-sandbox-x', 'playground-label-malformed'],
    ['vpc', 'plumbline-shared', 'playground-label-malformed'], ['instance', 'foreign-box', 'scope-label-prefix'],
  ] as const)('DENIES %s %s (%s)', (cls, label, rule) => {
    const d = decide(cls, label);
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe(rule);
  });
  it('a protected tag is refused for instances, VPCs and firewall groups (AG4-VER-5 tag coverage)', () => {
    for (const cls of ['instance', 'vpc', 'firewall_group'] as const) {
      const label = cls === 'instance' ? 'plumbline-wk-1' : GOOD;
      expect(decide(cls, label, ['protected']).rule_id).toBe('protect-tagged-destroy');
    }
  });
  it('a registry is never allowed by the watchdog policy, whatever its label', () => {
    expect(decide('registry', GOOD).decision).not.toBe('ALLOW');
  });
});

describe('sweep: lapsed lease', () => {
  it('destroys ONLY workers and playground resources; infra, prod, registry and look-alikes survive', async () => {
    const r = rig();
    stock(r.f);
    lapsed(r);
    expect(await r.dog.tick()).toBe('DESTROYING');
    expect(r.f.deletes.sort()).toEqual(['g-play', 'i-wk1', 'i-wk2', 'v-play']);
    const left = [...r.f.instances, ...r.f.vpcs, ...r.f.firewalls].map((x) => x.id);
    for (const id of SURVIVORS) expect(left).toContain(id);
    expect(r.f.calls.filter((c) => c.startsWith('DELETE')).every((c) => /\/(instances|vpcs|firewalls)\//.test(c))).toBe(true);
    expect(r.f.calls.some((c) => c.includes('/registr'))).toBe(false);
  });

  it('writes the F5 destroy log (act, id, class, ts) which the verifier reads for its destroyed-tolerance', async () => {
    const r = rig();
    stock(r.f);
    lapsed(r);
    await r.dog.tick();
    const lines = readFileSync(join(r.dir, ACTIONS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const destroyed = lines.filter((l) => l.act === 'destroyed');
    expect(destroyed.map((l) => l.id).sort()).toEqual(['g-play', 'i-wk1', 'i-wk2', 'v-play']);
    for (const l of destroyed) expect(l).toMatchObject({ act: 'destroyed', ts: T, class: expect.stringMatching(/^(instance|vpc|firewall_group)$/) });
    const seen = readDestroyed(r.dir, MY_UID);
    expect(seen.rejected).toBeUndefined();
    expect(seen.entries.map((e) => e.id).sort()).toEqual(['g-play', 'i-wk1', 'i-wk2', 'v-play']);
  });

  it('publishes the status file and does not delete again once everything is gone (DONE)', async () => {
    const r = rig();
    stock(r.f);
    lapsed(r);
    await r.dog.tick();
    expect(status(r)).toMatchObject({ status: 'DESTROYING', lease: 'LAPSED', dry_run: false });
    expect(await r.dog.tick()).toBe('DONE');
    expect(r.f.deletes).toHaveLength(4);
    expect(statSync(join(r.dir, STATUS_FILE)).mode & 0o777).toBe(0o644);
  });

  it('a failed delete is retried on the next tick with a fresh request id (no ALLOW replay) and the watchdog reports DEGRADED', async () => {
    const r = rig();
    r.f.instances.push({ id: 'i-wk1', label: 'plumbline-wk-1' });
    lapsed(r);
    r.f.deleteScript.push(403);
    expect(await r.dog.tick()).toBe('DEGRADED');
    expect(r.f.deletes).toEqual([]);
    expect(await r.dog.tick()).toBe('DESTROYING');
    expect(r.f.deletes).toEqual(['i-wk1']);
  });

  it('a mock Vultr 429 backs off (retry-after honoured) and the delete still lands', async () => {
    const r = rig();
    r.f.instances.push({ id: 'i-wk1', label: 'plumbline-wk-1' });
    lapsed(r);
    r.f.deleteScript.push(429, 429);
    expect(await r.dog.tick()).toBe('DESTROYING');
    expect(r.f.deletes).toEqual(['i-wk1']);
    expect(r.f.sleeps.filter((ms) => ms === 2000)).toHaveLength(2);
  });

  it('a persistent 429 on listing deletes nothing, reports DEGRADED and never throws', async () => {
    const r = rig();
    stock(r.f);
    lapsed(r);
    r.f.listScript.push(...Array(40).fill(429));
    expect(await r.dog.tick()).toBe('DEGRADED');
    expect(r.f.deletes).toEqual([]);
    expect(status(r).lease).toBe('LAPSED');
  });

  it('one list endpoint failing (e.g. VPC ACL gap) does not stop the workers from being destroyed', async () => {
    const r = rig();
    stock(r.f);
    lapsed(r);
    r.f.listScript.push(200, 403);
    expect(await r.dog.tick()).toBe('DEGRADED');
    expect(r.f.deletes).toContain('i-wk1');
    expect(r.f.deletes).toContain('i-wk2');
  });

  it('an unknown delete outcome (5xx) is not logged destroyed until the id is gone from a complete listing', async () => {
    const r = rig();
    r.f.instances.push({ id: 'i-wk1', label: 'plumbline-wk-1' });
    lapsed(r);
    r.f.deleteScript.push('500x');
    expect(await r.dog.tick()).toBe('DEGRADED');
    expect(readDestroyed(r.dir, MY_UID).entries).toEqual([]);
    r.clock.now += 1000;
    await r.dog.tick();
    expect(readDestroyed(r.dir, MY_UID).entries.map((e) => e.id)).toEqual(['i-wk1']);
  });
});

describe('control run (AG4-OPS-4): a live lease sweeps nothing', () => {
  it('ALIVE makes no Vultr call at all and deletes nothing', async () => {
    const r = rig();
    stock(r.f);
    alive(r);
    expect(await r.dog.tick()).toBe('ALIVE');
    expect(r.f.calls).toEqual([]);
    expect(r.f.deletes).toEqual([]);
    expect(status(r)).toMatchObject({ status: 'ALIVE', lease: 'ALIVE', ever_seen: true, would_delete: [] });
  });

  it('a lease that renews right before expiry keeps the fleet; the same lease one second later sweeps', async () => {
    const r = rig();
    stock(r.f);
    writeLease(r.dir, { last_ts: T, ttl_s: 20, received_at: T });
    r.clock.now = T + 20_000;
    expect(await r.dog.tick()).toBe('ALIVE');
    r.clock.now = T + 21_000;
    expect(await r.dog.tick()).toBe('DESTROYING');
    expect(r.f.deletes).toHaveLength(4);
  });
});

describe('lease fails CLOSED (AG4-VER-3)', () => {
  const sweeps = async (r: Rig): Promise<boolean> => { await r.dog.tick(); return r.f.deletes.length > 0; };
  const seed = (r: Rig): void => { r.f.instances.push({ id: 'i-wk1', label: 'plumbline-wk-1' }); };

  it('a missing lease file is a grace period (NEVER, no sweep) and then a sweep, never GREEN/alive forever', async () => {
    const r = rig({ graceMs: 60_000 });
    seed(r);
    expect(await r.dog.tick()).toBe('NEVER');
    expect(r.f.deletes).toEqual([]);
    r.clock.now = T + 61_000;
    expect(await sweeps(r)).toBe(true);
    expect(status(r).lease_reason).toBe('missing');
  });

  it('once the lease has been seen alive, a vanished file sweeps immediately', async () => {
    const r = rig({ graceMs: 600_000 });
    seed(r);
    alive(r);
    expect(await r.dog.tick()).toBe('ALIVE');
    writeLease(r.dir, 'x');
    r.clock.now = T + 1;
    expect(await r.dog.tick()).toBe('DESTROYING');
  });

  const past = (r: Rig): void => { r.clock.now = T + 500_000; };
  it.each([
    ['unparseable', 'not json{'], ['wrong types', { last_ts: 'a', ttl_s: 'b', received_at: 'c' }], ['over the reader bound (ttl 500)', { last_ts: 1, ttl_s: 500, received_at: T + 500_000 }],
    ['over the verifier ceiling (ttl 200, otherwise fresh)', { last_ts: 1, ttl_s: 200, received_at: T + 500_000 }],
    ['ttl 0 (kill-switch)', { last_ts: 1, ttl_s: 0, received_at: T + 500_000 }],
    ['replayed: an old heartbeat re-written long after it was received', { last_ts: 1, ttl_s: 45, received_at: T }],
    ['received_at far in the future', { last_ts: 1, ttl_s: 45, received_at: T + 500_000 + 60_000 }],
  ] as const)('%s sweeps', async (_n, body) => {
    const r = rig({ graceMs: 10_000 });
    seed(r);
    writeLease(r.dir, body);
    past(r);
    expect(await sweeps(r)).toBe(true);
  });

  it('a lease file the verifier does not own, a group-writable one and a symlink are all ignored (sweep)', async () => {
    for (const make of ['other-owner', 'group-writable', 'symlink'] as const) {
      const r = rig({ graceMs: 10_000, verifierUid: make === 'other-owner' ? MY_UID + 1 : MY_UID });
      seed(r);
      past(r);
      const fresh = { last_ts: 1, ttl_s: 45, received_at: r.clock.now - 1000 };
      if (make === 'symlink') {
        writeFileSync(join(r.dir, 'real.json'), JSON.stringify(fresh));
        symlinkSync(join(r.dir, 'real.json'), join(r.dir, 'lease.json'));
      } else writeLease(r.dir, fresh, make === 'group-writable' ? 0o660 : 0o640);
      expect(await sweeps(r), make).toBe(true);
      expect(String(status(r).lease_reason)).toContain(make === 'other-owner' ? 'owned by uid' : make === 'symlink' ? 'not a regular file' : 'writable');
    }
  });

  it('diagnoseLease names why a null lease is null', () => {
    const r = rig();
    expect(diagnoseLease(r.dir, MY_UID)).toBe('missing');
    writeLease(r.dir, 'zzz');
    expect(diagnoseLease(r.dir, MY_UID)).toContain('unparseable');
  });
});

describe('dry-run (DT-21): prints exactly what it would delete and deletes nothing', () => {
  it('reports would_delete for the scoped set only, makes no DELETE call, writes no destroyed entry', async () => {
    const r = rig({ dryRun: true });
    stock(r.f);
    lapsed(r);
    expect(await r.dog.tick()).toBe('DESTROYING');
    expect(r.f.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    expect(r.f.deletes).toEqual([]);
    const s = status(r) as { would_delete: { id: string; label: string; class: string }[]; dry_run: boolean };
    expect(s.dry_run).toBe(true);
    expect(s.would_delete.map((w) => w.id).sort()).toEqual(['g-play', 'i-wk1', 'i-wk2', 'v-play']);
    expect(s.would_delete.every((w) => w.label.startsWith('plumbline-wk-') || w.label.startsWith('plumbline-s0') || w.label.startsWith('plumbline-s8'))).toBe(true);
    expect(JSON.stringify(s.would_delete)).not.toMatch(/infra|prod|registry|plumblinereg/);
    expect(readDestroyed(r.dir, MY_UID).entries).toEqual([]);
    expect(r.f.instances).toHaveLength(7);
  });

  it('only an explicit PLUMBLINE_WATCHDOG_DRY_RUN=0 goes live', () => {
    expect(resolveDryRun({})).toBe(true);
    expect(resolveDryRun({ PLUMBLINE_WATCHDOG_DRY_RUN: '1' })).toBe(true);
    expect(resolveDryRun({ PLUMBLINE_WATCHDOG_DRY_RUN: '' })).toBe(true);
    expect(resolveDryRun({ PLUMBLINE_WATCHDOG_DRY_RUN: 'false' })).toBe(true);
    expect(resolveDryRun({ PLUMBLINE_WATCHDOG_DRY_RUN: '0' })).toBe(false);
  });
});

describe('baseline ids are never deleted', () => {
  it('a baseline id survives even with an in-scope label', async () => {
    const r = rig({ baseline: new Set(['i-wk1', 'v-play']) });
    stock(r.f);
    lapsed(r);
    await r.dog.tick();
    expect(r.f.deletes.sort()).toEqual(['g-play', 'i-wk2']);
    const sweep = status(r).sweep as { protected_skipped: string[] };
    expect(sweep.protected_skipped.sort()).toEqual(['i-wk1', 'v-play']);
  });

  it('an unreadable baseline is reported but does not disarm the dead hand (the allow-list and the floor still bound it)', async () => {
    const r = rig({ baseline: null });
    stock(r.f);
    lapsed(r);
    await r.dog.tick();
    expect(status(r).baseline).toBe('unavailable');
    expect(r.f.deletes.sort()).toEqual(['g-play', 'i-wk1', 'i-wk2', 'v-play']);
    for (const id of SURVIVORS) expect([...r.f.instances, ...r.f.vpcs, ...r.f.firewalls].map((x) => x.id)).toContain(id);
  });
});

describe('the adapter refuses a delete that is not a genuine engine ALLOW', () => {
  it('a DENY (or a forged object) cannot delete: no DELETE reaches the provider', async () => {
    const r = rig();
    const { req, decision } = decideDelete({ id: 'i-prod', label: 'plumbline-prod-db', tags: [], cls: 'instance' }, watchdogPolicy(), FLOOR, T, 1);
    expect(decision.decision).toBe('DENY');
    await expect(new Instances(r.http).delete(decision as never, req)).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
    await expect(new Instances(r.http).delete({ ...decision, decision: 'ALLOW' } as never, req)).rejects.toThrow('NOT_AN_ENGINE_ALLOW');
    expect(r.f.calls).toEqual([]);
  });
});

describe('AG4-VER-7: the watchdog key must carry exactly provisioning + firewall (fail closed)', () => {
  it('accepts exactly provisioning + firewall', async () => {
    const r = rig();
    expect((await assertWatchdogKey(r.http)).sort()).toEqual(['firewall', 'provisioning']);
  });
  it.each([
    ['an extra ACL', [TIER_ACL.deployer, TIER_ACL.network, 'billing'], 'over-scoped'],
    ['view-only key', [TIER_ACL.observer], 'over-scoped'],
    ['the owner key (everything)', ['manage_users', 'provisioning', 'firewall', 'objstore'], 'over-scoped'],
    ['a missing firewall ACL', [TIER_ACL.deployer], 'lacks firewall'],
    ['a missing provisioning ACL', [TIER_ACL.network], 'lacks provisioning'],
    ['no ACLs at all', [], 'lacks'],
  ] as const)('refuses %s', async (_n, acls, why) => {
    const r = rig();
    r.f.accountAcls = [...acls];
    await expect(assertWatchdogKey(r.http)).rejects.toThrow(why);
  });
  it('refuses when the ACLs cannot be read (403 or no acls array)', async () => {
    const r = rig();
    r.f.accountAcls = 'forbidden';
    // LIVE FINDING: 403 on /account falls back to the behavioral check; this rig answers 200 on the paths that must be 403, so it is refused as over-scoped (never accepted)
    await expect(assertWatchdogKey(r.http)).rejects.toThrow(/BOOT_REFUSED: the watchdog key is over-scoped: GET \/users answered 404, expected 403/);
    r.f.accountAcls = 'no-acls';
    await expect(assertWatchdogKey(r.http)).rejects.toThrow('BOOT_REFUSED: cannot read');
  });
});

describe('AG4-VER-4: the destroy log is owned by the watchdog, mode 0644, never a symlink', () => {
  it('creates the log 0644 owned by the running uid', () => {
    const r = rig();
    const st = statSync(join(r.dir, ACTIONS_FILE));
    expect(st.mode & 0o777).toBe(0o644);
    expect(st.uid).toBe(MY_UID);
  });
  it('repairs a world-writable log back to 0644 and refuses to follow a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plb-wd-log-'));
    writeFileSync(join(dir, ACTIONS_FILE), '');
    chmodSync(join(dir, ACTIONS_FILE), 0o666);
    new ActionsLog(dir, () => T);
    expect(statSync(join(dir, ACTIONS_FILE)).mode & 0o777).toBe(0o644);
    const dir2 = mkdtempSync(join(tmpdir(), 'plb-wd-log-'));
    writeFileSync(join(dir2, 'elsewhere'), '');
    symlinkSync(join(dir2, 'elsewhere'), join(dir2, ACTIONS_FILE));
    expect(() => new ActionsLog(dir2, () => T)).toThrow();
    expect(readFileSync(join(dir2, 'elsewhere'), 'utf8')).toBe('');
    expect(existsSync(join(dir2, ACTIONS_FILE))).toBe(true);
  });
});

describe('boot guards', () => {
  it('assertOwnUser refuses root, the verifier user and an unset verifier uid', () => {
    expect(() => assertOwnUser(0, 998)).toThrow('root');
    expect(() => assertOwnUser(998, 998)).toThrow('own user');
    expect(() => assertOwnUser(997, null)).toThrow('PLUMBLINE_VERIFIER_UID');
    expect(() => assertOwnUser(997, 998)).not.toThrow();
  });
  it('the watchdog config refuses the verifier key, the lease secret and the owner key, and an unreplaced uid placeholder', () => {
    const env = { PLUMBLINE_WATCHDOG_KEY: 'k', PLUMBLINE_POLICY_PUBKEY: 'p' };
    expect(loadWatchdogConfig({ ...env, PLUMBLINE_VERIFIER_UID: '998' }).verifierUid).toBe(998);
    for (const bad of ['PLUMBLINE_VERIFIER_KEY', 'PLUMBLINE_LEASE_SECRET', 'VULTR_API_KEY']) expect(() => loadWatchdogConfig({ ...env, [bad]: 'x' })).toThrow('BOOT_REFUSED');
    expect(() => loadWatchdogConfig({ ...env, PLUMBLINE_VERIFIER_UID: '__SET_BY_BOOTSTRAP__' })).toThrow('BOOT_REFUSED');
  });
  it('an unknown-outcome error type is the adapter one (sanity for the 5xx path)', () => {
    expect(new OutcomeUnknown('r', 'DELETE', '/instances/x', 'watchdog', 'boom', 0)).toBeInstanceOf(Error);
  });
});
