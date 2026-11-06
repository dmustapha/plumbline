import { describe, expect, it } from 'vitest';
import { reconcile, type Pin } from '../src/reconcile.ts';
import type { Snapshot } from '../src/vultr-lite.ts';
import { BASELINE, FLOOR, INFRA, T, brokerLive, healthy, input, live, prodBase, prodLive, regLive, snap } from './support.ts';

const worker = (id = 'i-wk', label = 'plumbline-wk-1') => live({ id, label });

describe('reconcile: GREEN, RED, DEGRADED', () => {
  it('GREEN when live matches baseline plus ALLOW rows, with decision counts and the registry (CO-2 H-1)', () => {
    const f = healthy();
    f.worker('i-wk');
    const r = reconcile(input(f.export(), [worker()]));
    expect(r.status).toBe('GREEN');
    expect(r.counts).toMatchObject({ allow: 1, unauthorized: 0, live: 4, baseline: 3 });
    expect(r.ledger.trust).toBe('fetched');
    expect(r.polled_twice).toBe(true);
  });

  it('H-1: the registry plumblinereg is in the baseline AND has a bootstrap ALLOW row; GREEN straight after bootstrap', () => {
    const f = healthy();
    const r = reconcile(input(f.export()));
    expect(r.status).toBe('GREEN');
    expect(f.export().resources.map((x) => x.label)).toContain('plumblinereg');
    expect(BASELINE.map((b) => b.label)).toContain('plumblinereg');
    expect(reconcile(input(f.export(), [], { poll1: snap([prodLive, brokerLive]), poll2: snap([prodLive, brokerLive], T + 3000) })).codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED', 'RECONCILE_RED_MISSING']);
  });

  it('RED_UNLOGGED names the out-of-band instance and returns to GREEN after its destroy', () => {
    const f = healthy();
    const rogue = live({ id: 'i-rogue', label: 'oops', status: 'pending' });
    const red = reconcile(input(f.export(), [rogue]));
    expect(red.status).toBe('RED');
    expect(red.codes).toEqual(['RECONCILE_RED_UNLOGGED']);
    expect(red.findings[0]?.resource_id).toBe('i-rogue');
    expect(red.counts.unauthorized).toBe(1);
    expect(reconcile(input(f.export())).status).toBe('GREEN');
  });

  it('E-2: a rogue VPC (the playground is a VPC) is in the live-list compare; a ledgered one is GREEN', () => {
    const f = healthy();
    const rogue = live({ id: 'v-rogue', class: 'vpc', label: 'plumbline-sdeadbeef-play', plan: '', power_status: '', os: '' });
    expect(reconcile(input(f.export(), [rogue])).findings[0]).toMatchObject({ code: 'RECONCILE_RED_UNLOGGED', resource_id: 'v-rogue', class: 'vpc' });
    f.create('v-ok', 'vpc', { label: 'plumbline-s0a1b2c3d-play', region: 'ewr', subnet: '10.9.0.0', subnet_size: 24 });
    const ok = live({ id: 'v-ok', class: 'vpc', label: 'plumbline-s0a1b2c3d-play', plan: '', power_status: '', os: '' });
    expect(reconcile(input(f.export(), [ok])).status).toBe('GREEN');
  });

  it('a one-poll flicker is not declared', () => {
    const f = healthy();
    const r = reconcile(input(f.export(), [], { poll1: snap([...INFRA, live({ id: 'i-rogue', label: 'oops' })]) }));
    expect(r.status).toBe('GREEN');
  });

  it('RED_MISSING when an ALLOW row has no live resource', () => {
    const f = healthy();
    f.worker('i-gone');
    const r = reconcile(input(f.export()));
    expect(r.codes).toEqual(['RECONCILE_RED_MISSING']);
    expect(r.findings[0]?.resource_id).toBe('i-gone');
  });

  it('a live resource the ledger says was destroyed is unlogged', () => {
    const f = healthy();
    f.worker('i-z');
    f.clock = T - 200_000;
    f.ledger.markDestroyed('i-z');
    expect(reconcile(input(f.export(), [worker('i-z')])).codes).toEqual(['RECONCILE_RED_UNLOGGED']);
  });

  it('every report states its coverage limits', () => {
    const r = reconcile(input(healthy().export()));
    expect(r.limits).toContain('point-in-time');
    expect(r.not_covered.join(' ')).toContain('firewall_group');
    expect(r.not_covered.join(' ')).toContain('bucket');
    expect(r.coverage).toEqual(['instance', 'vpc', 'registry']);
  });
});

describe('DEGRADED, never GREEN', () => {
  const bad: Snapshot = { ok: false, at: 1, error: 'VULTR_429' };
  it('a failed poll or an unavailable export', () => {
    const e = healthy().export();
    expect(reconcile(input(e, [], { poll1: bad })).status).toBe('DEGRADED');
    expect(reconcile(input(e, [], { poll2: bad })).status).toBe('DEGRADED');
    const r = reconcile(input(e, [], { ledger: null, ledgerError: 'HTTP 500' }));
    expect(r).toMatchObject({ status: 'DEGRADED', codes: ['RECONCILE_DEGRADED'] });
    expect(r.findings[0]?.detail).toContain('HTTP 500');
  });

  it('AG4-VER-8: a missing, empty or incomplete baseline is DEGRADED (a missing file was silently [])', () => {
    const e = healthy().export();
    expect(reconcile(input(e, [], { baseline: null })).status).toBe('DEGRADED');
    expect(reconcile(input(e, [], { baseline: [] })).status).toBe('DEGRADED');
    const noPower = { ...prodBase, power_status: undefined };
    expect(reconcile(input(e, [], { baseline: [noPower, ...BASELINE.slice(1)] })).findings[0]?.detail).toContain('power_status');
  });

  it('an unavailable floor means E-1 cannot run: DEGRADED', () => {
    expect(reconcile(input(healthy().export(), [], { floor: null })).status).toBe('DEGRADED');
  });

  it('AG4-VER-1: a stale export is DEGRADED, not trusted', () => {
    const e = healthy().export(T - 400_000);
    const r = reconcile(input(e));
    expect(r.status).toBe('DEGRADED');
    expect(r.findings[0]?.detail).toContain('STALE');
  });

  it('AG4-PRD-7: an export taken BEFORE the live poll is DEGRADED (order: list first, export second)', () => {
    const e = healthy().export(T - 30_000);
    const r = reconcile(input(e, [], { maxExportAgeMs: 120_000 }));
    expect(r.status).toBe('DEGRADED');
    expect(r.findings[0]?.detail).toContain('predates');
  });
});

describe('CO-2 H-3: protected baseline compares power_status and os', () => {
  const run = (changed: Partial<typeof prodLive>) => {
    const p = { ...prodLive, ...changed };
    return reconcile(input(healthy().export(), [], { poll1: snap([p, regLive, brokerLive]), poll2: snap([p, regLive, brokerLive], T + 3000) }));
  };
  it('stopped prod-db is RECONCILE_RED_PROTECTED_CHANGED', () => {
    const r = run({ power_status: 'stopped' });
    expect(r.codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED']);
    expect(r.findings[0]?.detail).toContain('power_status running -> stopped');
  });
  it('a changed os or plan is RECONCILE_RED_PROTECTED_CHANGED', () => {
    expect(run({ os: 'Ubuntu 22.04' }).codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED']);
    expect(run({ plan: 'vc2-2c-4gb' }).codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED']);
  });
  it('a relabelled or deleted prod-db is RECONCILE_RED_PROTECTED_CHANGED', () => {
    expect(run({ label: 'renamed' }).codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED']);
    const gone = reconcile(input(healthy().export(), [], { poll1: snap([regLive, brokerLive]), poll2: snap([regLive, brokerLive], T + 3000) }));
    expect(gone.codes).toEqual(['RECONCILE_RED_PROTECTED_CHANGED']);
  });
});

describe('CO-2 H-2 / E-1: the policy engine is re-run on live state (AG4-VER-1)', () => {
  it('a live vc2-24c-96gb in sgp with a matching ledger row reconciles RED', () => {
    const f = healthy();
    f.create('i-big', 'instance', { plan: 'vc2-24c-96gb', region: 'sgp', label: 'plumbline-wk-9', ttl_h: 1 }, { weak: true });
    const big = live({ id: 'i-big', label: 'plumbline-wk-9', plan: 'vc2-24c-96gb', region: 'sgp' });
    const r = reconcile(input(f.export(), [big]));
    expect(r.status).toBe('RED');
    expect(r.codes).toEqual(['RECONCILE_RED_POLICY_VIOLATION']);
    expect(r.findings[0]).toMatchObject({ resource_id: 'i-big' });
    expect(r.findings[0]?.detail).toMatch(/plan-not-allowed|region-not-allowed/);
  });

  it('a live plan that differs from the plan the ALLOW decided is RED even if the live plan is allowed', () => {
    const f = healthy();
    f.create('i-up', 'instance', { plan: 'vc2-1c-0.5gb', region: 'ewr', label: 'plumbline-wk-3', ttl_h: 1 });
    const grown = live({ id: 'i-up', label: 'plumbline-wk-3', plan: 'vc2-1c-1gb' });
    const r = reconcile(input(f.export(), [grown]));
    expect(r.codes).toEqual(['RECONCILE_RED_POLICY_VIOLATION']);
    expect(r.findings[0]?.detail).toContain('plan vc2-1c-0.5gb -> vc2-1c-1gb');
  });

  it('a legitimate worker is not flagged', () => {
    const f = healthy();
    f.worker('i-wk');
    expect(reconcile(input(f.export(), [worker()])).findings).toEqual([]);
  });
});

describe('AG4-VER-1: export integrity (chain, tie to ALLOW, pinned head, continuity)', () => {
  it('an edited row (plan rewritten, hash not recomputed) is RED_LEDGER_TAMPERED', () => {
    const f = healthy();
    f.worker('i-wk');
    const e = f.export();
    e.resources[1]!.plan = 'vc2-1c-0.5gb';
    const r = reconcile(input(e, [worker()]));
    expect(r).toMatchObject({ status: 'RED', codes: ['RECONCILE_RED_LEDGER_TAMPERED'] });
  });

  it('a made-up allow_decision_id is RED (resource not tied to an ALLOW row)', () => {
    const f = healthy();
    f.worker('i-wk');
    f.db.prepare("UPDATE resources SET allow_decision_id = 'made-up' WHERE id = 'i-wk'").run();
    expect(reconcile(input(f.export(), [worker()])).codes).toEqual(['RECONCILE_RED_LEDGER_TAMPERED']);
  });

  it('a resource whose allow_decision_id points at a non-ALLOW row is RED', () => {
    const f = healthy();
    f.worker('i-wk');
    f.db.prepare('UPDATE resources SET allow_decision_id = ? WHERE id = ?').run(f.denied(), 'i-wk');
    expect(reconcile(input(f.export(), [worker()])).codes).toEqual(['RECONCILE_RED_LEDGER_TAMPERED']);
  });

  it('a pinned head that differs is RED; the matching pin passes', () => {
    const f = healthy();
    const e = f.export();
    expect(reconcile(input(e, [], { expectHead: 'f'.repeat(64) })).codes).toEqual(['RECONCILE_RED_LEDGER_TAMPERED']);
    expect(reconcile(input(e, [], { expectHead: e.chain_head })).status).toBe('GREEN');
  });

  it('continuity: a decision verified earlier must still be in the export unchanged', () => {
    const f = healthy();
    const pin: Pin = { seq: 1, row_hash: f.export().decisions[0]!.row_hash };
    expect(reconcile(input(f.export(), [], { continuity: pin })).status).toBe('GREEN');
    expect(reconcile(input(f.export(), [], { continuity: { seq: 1, row_hash: 'a'.repeat(64) } })).codes).toEqual(['RECONCILE_RED_LEDGER_TAMPERED']);
    expect(reconcile(input(f.export(), [], { continuity: { seq: 9, row_hash: pin.row_hash } })).codes).toEqual(['RECONCILE_RED_LEDGER_TAMPERED']);
  });

  it('the report carries the new pin (the last verified decision)', () => {
    const e = healthy().export();
    const r = reconcile(input(e));
    expect(r.ledger).toMatchObject({ head: e.chain_head, pin: { seq: e.decisions.length, row_hash: e.decisions.at(-1)!.row_hash } });
  });
});

describe('AG4-PRD-7: no false RED under concurrent worker creation', () => {
  it('a worker created after poll1 started is neither MISSING (in flight) nor UNLOGGED (the export is taken after the list)', () => {
    const f = healthy();
    f.clock = T + 1000;
    f.worker('i-new');
    const r = reconcile(input(f.export(), [], { poll1: snap(INFRA, T), poll2: snap([...INFRA, worker('i-new')], T + 3000) }));
    expect(r.status).toBe('GREEN');
  });

  it('a ledger row newer than the poll that is still absent from the live list is in flight, not MISSING', () => {
    const f = healthy();
    f.clock = T + 2000;
    f.worker('i-late');
    expect(reconcile(input(f.export())).status).toBe('GREEN');
  });

  it('but an old ALLOW row with no live resource is still MISSING', () => {
    const f = healthy();
    f.clock = T - 60_000;
    f.worker('i-old');
    expect(reconcile(input(f.export())).codes).toEqual(['RECONCILE_RED_MISSING']);
  });

  it('a destroy recorded moments ago while Vultr still lists the VM (0.8 s) is not unlogged', () => {
    const f = healthy();
    f.worker('i-bye');
    f.clock = T - 1000;
    f.ledger.markDestroyed('i-bye');
    expect(reconcile(input(f.export(), [worker('i-bye')])).status).toBe('GREEN');
  });
});

describe('AG4-VER-4: the watchdog destroy log excuses MISSING only after the ALLOW row', () => {
  const setup = () => {
    const f = healthy();
    f.clock = T - 100_000;
    f.worker('i-gone');
    return f.export();
  };
  it('an entry at or after the ALLOW row excuses the missing resource', () => {
    expect(reconcile(input(setup(), [], { watchdogDestroyed: [{ id: 'i-gone', ts: T - 50_000 }] })).status).toBe('GREEN');
  });
  it('an entry BEFORE the ALLOW row (pre-planted tolerance) excuses nothing', () => {
    expect(reconcile(input(setup(), [], { watchdogDestroyed: [{ id: 'i-gone', ts: T - 900_000 }] })).codes).toEqual(['RECONCILE_RED_MISSING']);
  });
  it('an entry for another id excuses nothing', () => {
    expect(reconcile(input(setup(), [], { watchdogDestroyed: [{ id: 'i-other', ts: T }] })).codes).toEqual(['RECONCILE_RED_MISSING']);
  });
});

describe('AG4-VER-6: weak and unverified modes never print GREEN', () => {
  it('a derived baseline (CLI without --baseline) downgrades GREEN to DEGRADED and says why', () => {
    const r = reconcile(input(healthy().export(), [], { baselineMode: 'derived' }));
    expect(r.status).toBe('DEGRADED');
    expect(r.notes.join(' ')).toContain('weak mode');
  });
  it('an unverified ledger downgrades GREEN to DEGRADED; a pinned one stays GREEN', () => {
    const e = healthy().export();
    expect(reconcile(input(e, [], { ledgerTrust: 'unverified' })).status).toBe('DEGRADED');
    expect(reconcile(input(e, [], { ledgerTrust: 'pinned', expectHead: e.chain_head })).status).toBe('GREEN');
  });
  it('weak mode still reports RED when there is a finding', () => {
    const r = reconcile(input(healthy().export(), [live({ id: 'i-rogue', label: 'oops' })], { baselineMode: 'derived', ledgerTrust: 'unverified' }));
    expect(r.status).toBe('RED');
  });
});

describe('CO-2 E-2: the verdict carries the verifier host\'s own read of plumbline-prod-db', () => {
  it('copies status, power_status, plan, region, os, read time and reader from the second poll', () => {
    const r = reconcile(input(healthy().export()));
    expect(r.prod_db).toEqual({ found: true, id: 'i-prod', label: 'plumbline-prod-db', status: 'active', power_status: 'running', plan: 'vc2-1c-1gb', region: 'ewr', os: 'Debian 12 x64 (bookworm)', read_at: T + 3000, read_by: 'verifier-host' });
  });
  it('shows a stopped prod-db as stopped (not relayed from the broker)', () => {
    const p = { ...prodLive, power_status: 'stopped' };
    const r = reconcile(input(healthy().export(), [], { poll2: snap([p, regLive, brokerLive], T + 3000) }));
    expect(r.prod_db.power_status).toBe('stopped');
  });
  it('found:false when the VM is not in the live list, and still present on a DEGRADED report', () => {
    const r = reconcile(input(healthy().export(), [], { poll2: snap([regLive, brokerLive], T + 3000), poll1: { ok: false, at: 1, error: 'x' } }));
    expect(r.prod_db).toMatchObject({ found: false, id: null, read_by: 'verifier-host' });
    expect(FLOOR.rules.length).toBeGreaterThan(0);
  });
});
