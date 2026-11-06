// File: packages/policy-engine/test/evaluate.test.ts
import { describe, expect, it } from 'vitest';
import { NonceStore, approvalDecisionId, approvalMessage, approveEscalation, assertAllow, evaluate, isGenuineAllow, parsePolicy, requestHash } from '../src/index.ts';
import { generateKeyPairSync, sign } from 'node:crypto';
import { allowAllSession, floor, prodDb, req, session, state, vault, worker } from './fixtures.ts';

const run = (r: ReturnType<typeof req>, s = state()) => evaluate(r, session, floor, s);
/** AG4-ENG-7: the floor ALONE. The session layer allows everything, so a DENY can only come from the floor. */
const runFloor = (r: ReturnType<typeof req>, s = state()) => evaluate(r, allowAllSession, floor, s);

describe('AC-L1-1 destroy-protected group', () => {
  const attacks = [
    req({ verb: 'delete', class: 'instance', target: prodDb }),
    req({ verb: 'update', class: 'instance', target: prodDb }),
    req({ verb: 'delete', class: 'firewall_group', target: vault }),
    req({ verb: 'update', class: 'firewall_group', target: vault }),
    req({ verb: 'delete', class: 'instance', target: { ...worker, tags: ['protected'] } }),
    req({ verb: 'delete', class: 'instance', target: { id: 'x', label: 'plumbline-prod-db', tags: ['Protected'] } }),
  ];
  it.each(attacks.map((a, i) => [i, a] as const))('fixture %i is DENY protect-tagged-destroy', (_i, a) => {
    const d = run(a);
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('protect-tagged-destroy');
  });
});

describe('floor layer (AG4-ENG-7: run against the floor alone)', () => {
  const create = (over: Record<string, unknown> = {}) =>
    req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1', ...over } });
  it('control: allow-all session with a clean request is ALLOW, so the cases below are floor denies', () => {
    expect(runFloor(create()).decision).toBe('ALLOW');
  });
  it('AG4-ENG-7 floor-prod-immutable holds under an allow-all session', () => {
    const d = runFloor(req({ verb: 'delete', class: 'instance', target: { id: 'i', label: 'plumbline-prod-db', tags: [], resolved: true } }));
    expect([d.decision, d.rule_id, d.layer]).toEqual(['DENY', 'floor-prod-immutable', 'floor']);
  });
  it('floor-prod-immutable does not fire on a worker', () => {
    expect(run(req({ verb: 'delete', class: 'instance', target: worker })).decision).toBe('ALLOW');
  });
  it('AG4-VER-5 plumbline-infra and plumbline-prod firewall groups, vpcs and registries are floor-protected', () => {
    for (const cls of ['firewall_group', 'vpc', 'registry'] as const) {
      for (const label of ['plumbline-infra-broker', 'plumbline-prod-edge']) {
        const d = runFloor(req({ verb: 'delete', class: cls, target: { id: 'x', label, tags: [], resolved: true } }));
        expect([d.decision, d.rule_id]).toEqual(['DENY', 'floor-prod-immutable']);
      }
    }
  });
  it('AG4-ENG-7 kill-switch-engaged denies every mutating verb and not list, floor alone', () => {
    expect(runFloor(create(), state({ kill_switch: true })).rule_id).toBe('kill-switch-engaged');
    expect(runFloor(req({ verb: 'list', class: 'instance' }), state({ kill_switch: true })).decision).toBe('ALLOW');
  });
  it('AG4-ENG-7 scope-label-prefix fires on foreign labels and unresolved ids, floor alone', () => {
    expect(runFloor(req({ verb: 'delete', class: 'instance', target: { id: 'zz', label: 'customer-db', tags: [], resolved: true } })).rule_id).toBe('scope-label-prefix');
    expect(runFloor(req({ verb: 'delete', class: 'instance', target: { id: 'unknown' } })).rule_id).toBe('scope-label-prefix');
  });
  it('AG4-ENG-7 egress-allowlist, floor alone', () => {
    expect(runFloor(req({ verb: 'fetch', class: 'http', params: { url: 'https://evil.example/x' } })).rule_id).toBe('egress-allowlist');
    expect(runFloor(req({ verb: 'fetch', class: 'http', params: { url: 'https://docs.vultr.com/a' } })).decision).toBe('ALLOW');
    expect(runFloor(req({ verb: 'fetch', class: 'http', params: { url: 'not a url' } })).rule_id).toBe('egress-allowlist');
  });
  it('AG4-ENG-7 acl-tier-denied and tier-key-unavailable, floor alone', () => {
    expect(runFloor(create(), state({ session_tier: 'observer' })).rule_id).toBe('acl-tier-denied');
    expect(runFloor(create(), state({ tier_available: { observer: true, deployer: false, network: true, objstore: true, registry: true } })).rule_id).toBe('tier-key-unavailable');
  });
  it('AG4-ENG-7 rate-card, global-cap and max-instances, floor alone', () => {
    expect(runFloor(create(), state({ rate_card: null })).rule_id).toBe('rate-card-unavailable');
    expect(runFloor(create(), state({ global_spent_usd: 9.999 })).rule_id).toBe('global-cap-exceeded');
    expect(runFloor(create(), state({ live_worker_count: 4 })).rule_id).toBe('max-instances');
  });
  it('AG4-PRD-1 ceiling, session cap, plan and region are floor rules: an allow-all session cannot lift them', () => {
    expect(runFloor(create({ ttl_h: 400 })).rule_id).toBe('ceiling-dollar-deny');
    expect(runFloor(create(), state({ session_spent_usd: 1.5 })).rule_id).toBe('session-cap-exceeded');
    expect(runFloor(create({ plan: 'vc2-64c-256gb' })).rule_id).toBe('plan-not-allowed');
    expect(runFloor(create({ region: 'lhr' })).rule_id).toBe('region-not-allowed');
    expect(runFloor(create({ ttl_h: 400 })).layer).toBe('floor');
  });
});

describe('AG4-PRD-1 hot-edited session cannot remove the dollar rules', () => {
  const mutated = (rules: string) => {
    const r = parsePolicy(`version: 9\nrules:\n${rules}`, 'session');
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.policy;
  };
  const edited = mutated('  - { id: allow-worker-create, effect: allow, priority: 10, match: { verb: [create], class: [instance] }, reason: judge edit }\n');
  const over = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 400, label: 'plumbline-wk-big' } });
  it('a session policy with the ceiling rules deleted still DENYs an over-ceiling create', () => {
    const d = evaluate(over, edited, floor, state());
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'ceiling-dollar-deny']);
  });
  it('a session policy with the plan and region rules deleted still DENYs', () => {
    const big = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-64c-256gb', region: 'lhr', label: 'plumbline-wk-b' } });
    expect(evaluate(big, edited, floor, state()).decision).toBe('DENY');
  });
});

describe('H-1 shared registry plumblinereg', () => {
  const shared = { id: 'reg-1', label: 'plumblinereg', tags: [] as string[], resolved: true };
  it('H-1 delete of plumblinereg is DENY under the default policy for any session', () => {
    for (const sid of ['s1', 's2']) {
      const d = evaluate(req({ session_id: sid, verb: 'delete', class: 'registry', target: shared }), session, floor, state());
      expect([d.decision, d.rule_id]).toEqual(['DENY', 'floor-registry-shared']);
    }
  });
  it('H-1 holds under an allow-all session; registry update is outside the catalog', () => {
    expect(runFloor(req({ verb: 'delete', class: 'registry', target: shared })).rule_id).toBe('floor-registry-shared');
    expect(runFloor(req({ verb: 'update', class: 'registry', target: shared })).rule_id).toBe('default-deny');
  });
  it('H-1 control: a session-owned registry is still deletable', () => {
    const own = { id: 'reg-2', label: 'plumbline-sa1b2c3d4-reg', tags: [] as string[], resolved: true };
    expect(run(req({ verb: 'delete', class: 'registry', target: own })).decision).toBe('ALLOW');
  });
});

describe('AG4-VER-5 protected vpc/registry and tightened plumbline-s prefix', () => {
  it('AG4-VER-5 protect-tagged-destroy covers vpc and registry tagged protected', () => {
    for (const cls of ['vpc', 'registry'] as const) {
      const d = run(req({ verb: 'delete', class: cls, target: { id: 'x', label: 'plumbline-sa1b2c3d4-x', tags: ['protected'], resolved: true } }));
      expect([d.decision, d.rule_id]).toEqual(['DENY', 'protect-tagged-destroy']);
    }
  });
  it('AG4-VER-5 labels that merely start with plumbline-s are not playground groups and cannot be deleted', () => {
    for (const label of ['plumbline-shared', 'plumbline-ssh-infra', 'plumbline-sandbox-x', 'plumbline-s1-vault', 'plumbline-sA1B2C3D4-vault', 'plumbline-sa1b2c3d4-']) {
      const d = runFloor(req({ verb: 'delete', class: 'firewall_group', target: { id: 'x', label, tags: [], resolved: true } }));
      expect([label, d.decision, d.rule_id]).toEqual([label, 'DENY', 'playground-label-malformed']);
    }
  });
  it('AG4-VER-5 a well-formed playground label is deletable', () => {
    expect(run(req({ verb: 'delete', class: 'firewall_group', target: { id: 'x', label: 'plumbline-sa1b2c3d4-vault', tags: [], resolved: true } })).decision).toBe('ALLOW');
  });
});

describe('AG4-BRK-7 policy writes from the sandbox', () => {
  const write = (over: Record<string, unknown> = {}) => req({ verb: 'write', class: 'policy', target: { id: 'sess-1' }, ...over });
  it('AG4-BRK-7 policy write with no caller flag (sandbox) is DENY even under an allow-all session', () => {
    expect(runFloor(write()).rule_id).toBe('policy-write-owner-only');
    expect(runFloor(write({ caller: 'sandbox' })).rule_id).toBe('policy-write-owner-only');
    expect(run(write()).decision).toBe('DENY');
  });
  it('AG4-BRK-7 the production policy is DENY from the sandbox for read and write, any id casing', () => {
    expect(runFloor(req({ verb: 'read', class: 'policy', target: { id: 'production' } })).rule_id).toBe('policy-production-immutable');
    expect(runFloor(write({ target: { id: ' Production ' } })).rule_id).toBe('policy-write-owner-only');
    expect(runFloor(req({ verb: 'read', class: 'policy', target: { id: 'PRODUCTION' } })).rule_id).toBe('policy-production-immutable');
  });
  it('AG4-BRK-7 the owner may write the session policy and read it', () => {
    expect(run(write({ caller: 'owner' })).decision).toBe('ALLOW');
    expect(run(req({ verb: 'read', class: 'policy', target: { id: 'sess-1' } })).decision).toBe('ALLOW');
  });
});

describe('AG4-ENG-2 target facts come from the resolved inventory', () => {
  it('AG4-ENG-2 a delete with an agent-claimed params.label on an unresolved id is DENY', () => {
    const d = run(req({ verb: 'delete', class: 'instance', target: { id: 'i-prod' }, params: { label: 'plumbline-wk-1' } }));
    expect(d.decision).toBe('DENY');
  });
  it('AG4-ENG-2 unresolved target with a claimed worker label and no protected tag is DENY target-unresolved', () => {
    const d = run(req({ verb: 'delete', class: 'instance', target: { id: 'i-prod', label: 'plumbline-wk-1', tags: [] } }));
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'target-unresolved']);
  });
  it('AG4-ENG-2 update, put and restore of unresolved ids are DENY too; the same call resolved is ALLOW', () => {
    const t = { id: 'i-wk1', label: 'plumbline-wk-aaaa1111', tags: [] as string[] };
    expect(run(req({ verb: 'update', class: 'instance', target: t })).rule_id).toBe('target-unresolved');
    expect(run(req({ verb: 'put', class: 'bucket_object', target: { id: 'o', label: 'plumbline-orders-db' } })).rule_id).toBe('target-unresolved');
    expect(run(req({ verb: 'update', class: 'instance', target: { ...t, resolved: true } })).decision).toBe('ALLOW');
  });
  it('AG4-ENG-2 params.label never stands in for the target label on non-create verbs', () => {
    const d = runFloor(req({ verb: 'delete', class: 'instance', target: { id: 'zz', resolved: true }, params: { label: 'plumbline-wk-1' } }));
    expect(d.rule_id).toBe('scope-label-prefix');
  });
});

describe('AG4-ENG-3 ttl_h must be finite and above zero', () => {
  const withTtl = (ttl: unknown) =>
    req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1', ttl_h: ttl as number } });
  it.each([[Number.NaN], [Infinity], [-Infinity], [0], [-1], ['5'], [null], [{}], [true]])('AG4-ENG-3 ttl_h %j denies', (ttl) => {
    for (const sess of [session, allowAllSession]) {
      const d = evaluate(withTtl(ttl), sess, floor, state());
      expect(d.decision).toBe('DENY');
      expect(d.rule_id).toBe('ttl-invalid');
    }
  });
  it('AG4-ENG-3 a NaN ttl_h cannot slip past the ceiling when both layers are empty', () => {
    const empty = { version: 1, layer: 'floor' as const, hash: 'e', rules: [] };
    expect(evaluate(withTtl(Number.NaN), allowAllSession, empty, state()).decision).toBe('DENY');
  });
  it('AG4-ENG-3 a valid fractional ttl_h still prices at the one-hour minimum', () => {
    expect(run(withTtl(0.1)).decision).toBe('ALLOW');
  });
});

describe('AG4-ENG-4 unknown facts fail closed', () => {
  const del = req({ verb: 'delete', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', tags: [], resolved: true } });
  it('AG4-ENG-4 unknown object_versions escalates or denies a bucket delete, never ALLOW', () => {
    const d = run(del, state({ object_versions: null }));
    expect(d.decision).not.toBe('ALLOW');
  });
  it('AG4-ENG-4 the session last-copy-block rule alone escalates on null versions (floor deny absent)', () => {
    const noFloor = { version: 1, layer: 'floor' as const, hash: 'e', rules: [] };
    const d = evaluate(del, session, noFloor, state({ object_versions: null }));
    expect([d.decision, d.rule_id]).toEqual(['ESCALATE', 'last-copy-block']);
  });
  it('AG4-ENG-4 unknown restorable with the bond enabled escalates bond-required', () => {
    const noFloor = { version: 1, layer: 'floor' as const, hash: 'e', rules: [] };
    const d = evaluate(del, session, noFloor, state({ restorable: null, bond: { enabled: true, free_usd: 3.5 } }));
    expect(d.decision).toBe('ESCALATE');
  });
  it('AG4-ENG-4 the floor denies when state is unknown even if the session layer drops last-copy-block', () => {
    const d = runFloor(del, state({ object_versions: null }));
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'object-state-unknown']);
    expect(runFloor(del, state({ restorable: null, bond: { enabled: true, free_usd: 1 } })).rule_id).toBe('object-state-unknown');
  });
  it('AG4-ENG-4 known state is unaffected', () => {
    expect(run(del, state({ object_versions: 2 })).decision).toBe('ALLOW');
  });
});

describe('AG4-ENG-5 plan missing from the rate card', () => {
  const create = (plan: string | undefined) =>
    req({ verb: 'create', class: 'instance', params: { region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1', ...(plan ? { plan } : {}) } });
  it('AG4-ENG-5 a plan the rate card does not price is rate-card-unavailable DENY, not cost 0', () => {
    const lean = state({ rate_card: { fetched_at_ms: 999_000, hourly: { 'vc2-1c-0.5gb': 0.005 } } });
    const d = runFloor(create('vc2-1c-1gb'), lean);
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'rate-card-unavailable']);
  });
  it('AG4-ENG-5 prototype keys and a missing plan are unpriceable too', () => {
    for (const plan of ['constructor', '__proto__', 'toString', undefined]) {
      expect(runFloor(create(plan)).rule_id === 'rate-card-unavailable' || runFloor(create(plan)).decision === 'DENY').toBe(true);
      expect(runFloor(create(plan)).decision).toBe('DENY');
    }
    expect(runFloor(create('constructor')).rule_id).toBe('rate-card-unavailable');
  });
});

describe('AG4-ENG-6 decision binding', () => {
  const del = (id: string, label = 'plumbline-wk-aaaa1111') => req({ verb: 'delete', class: 'instance', target: { id, label, tags: [], resolved: true } });
  it('AG4-ENG-6 an ALLOW carries target_id and request_hash', () => {
    const r = del('i-wk1');
    const d = run(r);
    expect(d.decision).toBe('ALLOW');
    expect(d.target_id).toBe('i-wk1');
    expect(d.request_hash).toBe(requestHash(r));
  });
  it('AG4-ENG-6 assertAllow throws when the adapter goes on to act on another target', () => {
    const d = run(del('i-wk1'));
    if (d.decision !== 'ALLOW') throw new Error('setup');
    expect(() => assertAllow(d, del('i-wk1'))).not.toThrow();
    expect(() => assertAllow(d, del('i-prod'))).toThrow('ALLOW_REQUEST_MISMATCH');
  });
  it('AG4-ENG-6 assertAllow throws on a changed plan, verb, class or extra param', () => {
    const make = (over: Record<string, unknown>) => req({ verb: 'create', class: 'instance', request_id: 'same', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1', ...over } });
    const d = run(make({}));
    if (d.decision !== 'ALLOW') throw new Error('setup');
    expect(() => assertAllow(d, make({}))).not.toThrow();
    expect(() => assertAllow(d, make({ plan: 'vc2-64c-256gb' }))).toThrow('request_hash');
    expect(() => assertAllow(d, make({ extra: 1 } as never))).toThrow('request_hash');
    expect(() => assertAllow(d, { ...make({}), verb: 'delete' })).toThrow('verb or class');
    expect(() => assertAllow(d, { ...make({}), class: 'vpc' })).toThrow('verb or class');
  });
  it('AG4-ENG-6 requestHash is key-order independent and rejects NaN and Infinity', () => {
    const a = req({ params: { plan: 'p', region: 'r' } });
    const b = req({ params: { region: 'r', plan: 'p' } });
    expect(requestHash(a)).toBe(requestHash(b));
    expect(() => requestHash(req({ params: { ttl_h: Number.NaN } }))).toThrow();
    expect(() => requestHash(req({ params: { ttl_h: Infinity } }))).toThrow();
    expect(requestHash(req({ params: { plan: 'p' } }))).not.toBe(requestHash(req({ params: { plan: 'q' } })));
  });
});

describe('dollar and capacity rules', () => {
  const create = (plan = 'vc2-1c-1gb', ttl = 1) =>
    req({ verb: 'create', class: 'instance', params: { plan, region: 'ewr', ttl_h: ttl, label: 'plumbline-wk-1' } });
  it('ceiling-dollar-deny carries the arithmetic line', () => {
    const d = run(create('vc2-1c-1gb', 3), state({ session_ceiling_usd: 0.02 }));
    expect(d.rule_id).toBe('ceiling-dollar-deny');
    expect(d.reason).toContain('0.0210');
    expect(d.reason).toContain('0.0200');
  });
  it('ceiling-dollar-deny does not fire inside the ceiling', () => {
    expect(run(create()).decision).toBe('ALLOW');
  });
  it('the one-hour minimum applies to ttl below one hour', () => {
    expect(run(create('vc2-1c-1gb', 0.1), state({ session_ceiling_usd: 0.0069 })).rule_id).toBe('ceiling-dollar-deny');
  });
  it('global-cap-exceeded and session-cap-exceeded', () => {
    expect(run(create(), state({ global_spent_usd: 9.999 })).rule_id).toBe('global-cap-exceeded');
    expect(run(create(), state({ session_spent_usd: 1.5 })).rule_id).toBe('session-cap-exceeded');
  });
  it('plan-not-allowed and region-not-allowed', () => {
    expect(run(create('vc2-64c-256gb')).rule_id).toBe('plan-not-allowed');
    const r = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'lhr', label: 'plumbline-wk-1' } });
    expect(run(r).rule_id).toBe('region-not-allowed');
  });
  it('max-instances fires at the cap and not below it', () => {
    expect(run(create(), state({ live_worker_count: 4 })).rule_id).toBe('max-instances');
    expect(run(create(), state({ live_worker_count: 3 })).decision).toBe('ALLOW');
  });
  it('rate-card-unavailable fails closed for a null and a stale card', () => {
    expect(run(create(), state({ rate_card: null })).rule_id).toBe('rate-card-unavailable');
    expect(run(create(), state({ rate_card: { fetched_at_ms: 1, hourly: { 'vc2-1c-1gb': 0.007 } } })).rule_id).toBe('rate-card-unavailable');
  });
  it('a plumbline label that is not a worker label on create is refused by the floor worker prefix (SEC-F4), not allowed', () => {
    const r = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-other' } });
    expect(run(r).rule_id).toBe('floor-worker-prefix');
  });
});

describe('rewind and bond rules', () => {
  const del = req({ verb: 'delete', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', tags: [], resolved: true } });
  it('last-copy-block escalates on the last version and not otherwise', () => {
    expect(run(del, state({ object_versions: 1 })).decision).toBe('ESCALATE');
    expect(run(del, state({ object_versions: 1 })).rule_id).toBe('last-copy-block');
    expect(run(del, state({ object_versions: 2 })).decision).toBe('ALLOW');
  });
  it('bond-required escalates an unrestorable delete only when the bond is enabled', () => {
    const on = state({ restorable: false, bond: { enabled: true, free_usd: 3.5 } });
    expect(run(del, on).rule_id).toBe('bond-required');
    expect(run(del, state({ restorable: false })).decision).toBe('ALLOW');
  });
  it('bond-insufficient denies a create above the free bond (refuses_after_slash precondition)', () => {
    const c = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1' } });
    expect(run(c, state({ bond: { enabled: true, free_usd: 0.001 } })).rule_id).toBe('bond-insufficient');
    expect(run(c, state({ bond: { enabled: true, free_usd: 3.5 } })).decision).toBe('ALLOW');
  });
});

describe('default-deny and brand', () => {
  it('unknown verb and unknown class are default-deny', () => {
    expect(run(req({ verb: 'detonate' as never, class: 'instance' })).rule_id).toBe('default-deny');
    expect(run(req({ verb: 'list', class: 'database' as never })).rule_id).toBe('default-deny');
  });
  it('only engine-minted decisions pass assertAllow', () => {
    const forged = { decision: 'ALLOW', rule_id: 'x', layer: 'session' };
    expect(isGenuineAllow(forged)).toBe(false);
    expect(() => assertAllow(forged as never, req({ verb: 'list', class: 'instance' }))).toThrow('NOT_AN_ENGINE_ALLOW');
    const d = run(req({ verb: 'list', class: 'instance' }));
    expect(isGenuineAllow(d)).toBe(true);
  });
  it('decisions are frozen', () => {
    const d = run(req({ verb: 'list', class: 'instance' }));
    expect(() => { (d as { rule_id: string }).rule_id = 'x'; }).toThrow();
  });
});

describe('hot-edit flip (F2) and signed approval', () => {
  const flipped = (() => {
    const text = [
      'version: 3', 'rules:',
      '  - id: protect-tagged-destroy', '    effect: escalate', '    priority: 90',
      '    match: { verb: [delete, update], class: [instance, firewall_group], tags_any: [protected] }',
      '    reason: judge edit to escalate',
      '  - id: allow-breadth-delete', '    effect: allow', '    priority: 10',
      '    match: { verb: [delete, update], class: [firewall_group, vpc, registry], label_prefix: [plumbline] }',
      '    reason: breadth delete',
    ].join('\n');
    const r = parsePolicy(text, 'session');
    if (!r.ok) throw new Error('invalid');
    return r.policy;
  })();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
  const signFor = (esc: Parameters<typeof approvalDecisionId>[0] & { request_hash: string }, nonce: string) =>
    sign(null, Buffer.from(approvalMessage(approvalDecisionId(esc), nonce, esc.request_hash)), privateKey).toString('base64');
  it('the session playground flips to ESCALATE and a signed approval yields an engine ALLOW', () => {
    const d = evaluate(req({ verb: 'delete', class: 'firewall_group', target: vault }), flipped, floor, state());
    expect(d.decision).toBe('ESCALATE');
    if (d.decision !== 'ESCALATE') return;
    const ok = approveEscalation(d, { nonce: 'n1', signature: signFor(d, 'n1') }, { publicKey: pub, nonceStore: new NonceStore() });
    expect(isGenuineAllow(ok)).toBe(true);
    expect(ok.request_hash).toBe(d.request_hash);
    expect(ok.target_id).toBe('fw-s1');
  });
  it('the same edit cannot flip plumbline-prod-db and a floor deny cannot be approved', () => {
    const d = evaluate(req({ verb: 'delete', class: 'instance', target: prodDb }), flipped, floor, state());
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('floor-prod-immutable');
    expect(() => approveEscalation(d as never, { nonce: 'n', signature: 'x' }, { publicKey: pub, nonceStore: new NonceStore() })).toThrow();
  });
  describe('AG4-ENG-1 approveEscalation requires a bound, single-use owner signature', () => {
    const esc = () => {
      const d = evaluate(req({ verb: 'delete', class: 'firewall_group', target: vault }), flipped, floor, state());
      if (d.decision !== 'ESCALATE') throw new Error('setup');
      return d;
    };
    const opts = () => ({ publicKey: pub, nonceStore: new NonceStore() });
    it('AG4-ENG-1 no signature is SIG_REQUIRED', () => {
      expect(() => approveEscalation(esc(), { nonce: 'n1' }, opts())).toThrow('SIG_REQUIRED');
    });
    it('AG4-ENG-1 a bad or foreign-key signature is SIG_INVALID', () => {
      const e = esc();
      expect(() => approveEscalation(e, { nonce: 'n1', signature: 'AAAA' }, opts())).toThrow('SIG_INVALID');
      const other = generateKeyPairSync('ed25519').privateKey;
      const forged = sign(null, Buffer.from(approvalMessage(approvalDecisionId(e), 'n1', e.request_hash)), other).toString('base64');
      expect(() => approveEscalation(e, { nonce: 'n1', signature: forged }, opts())).toThrow('SIG_INVALID');
    });
    it('AG4-ENG-1 a nonce is single-use: the replay is refused', () => {
      const e = esc();
      const o = opts();
      const a = { nonce: 'n9', signature: signFor(e, 'n9') };
      approveEscalation(e, a, o);
      expect(() => approveEscalation(e, a, o)).toThrow('NONCE_REPLAYED');
    });
    it('AG4-ENG-1 a failed signature does not burn the nonce', () => {
      const e = esc();
      const o = opts();
      expect(() => approveEscalation(e, { nonce: 'n5', signature: 'AAAA' }, o)).toThrow();
      expect(o.nonceStore.has('n5')).toBe(false);
    });
    it('AG4-BRK-5 an approval for one rule does not cover a different ESCALATE reason on the same call', () => {
      const del = req({ verb: 'delete', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', tags: [], resolved: true } });
      const noFloor = { version: 1, layer: 'floor' as const, hash: 'e', rules: [] };
      const last = evaluate(del, session, noFloor, state({ object_versions: 1 }));
      const bond = evaluate(del, session, noFloor, state({ restorable: false, bond: { enabled: true, free_usd: 3.5 } }));
      if (last.decision !== 'ESCALATE' || bond.decision !== 'ESCALATE') throw new Error('setup');
      expect([last.rule_id, bond.rule_id]).toEqual(['last-copy-block', 'bond-required']);
      expect(last.request_hash).toBe(bond.request_hash);
      const approvalForLast = { nonce: 'n7', signature: signFor(last, 'n7') };
      expect(() => approveEscalation(bond, approvalForLast, opts())).toThrow('SIG_INVALID');
      expect(isGenuineAllow(approveEscalation(last, approvalForLast, opts()))).toBe(true);
    });
    it('AG4-ENG-1 a forged escalation object is refused', () => {
      const e = esc();
      expect(() => approveEscalation({ ...e } as never, { nonce: 'n1', signature: signFor(e, 'n1') }, opts())).toThrow('NOT_AN_ENGINE_ESCALATION');
    });
  });
});

describe('PLAYGROUND-CAP region allow-list is per class', () => {
  const vpc = (region: string) => req({ verb: 'create', class: 'vpc', params: { region, label: 'plumbline-s1a2b3c4d-vault', subnet: '10.9.0.0', subnet_size: 24 } });
  const inst = (region: string) => req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region, ttl_h: 1, label: 'plumbline-wk-1' } });
  const reg = (region: string) => req({ verb: 'create', class: 'registry', params: { region, label: 'plumbline-s1a2b3c4d-reg', name: 'plumblines1a2b3c4dreg' } });
  it('PLAYGROUND-CAP a vpc in ord is allowed by the floor and in ewr too', () => {
    expect(runFloor(vpc('ord')).decision).toBe('ALLOW');
    expect(runFloor(vpc('ewr')).decision).toBe('ALLOW');
  });
  it('PLAYGROUND-CAP a vpc in ams is still DENY region-not-allowed', () => {
    const d = runFloor(vpc('ams'));
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'region-not-allowed']);
  });
  it('PLAYGROUND-CAP an instance or a registry in ord is still DENY region-not-allowed', () => {
    expect(runFloor(inst('ord')).rule_id).toBe('region-not-allowed');
    expect(runFloor(reg('ord')).rule_id).toBe('region-not-allowed');
    expect(runFloor(inst('ewr')).decision).toBe('ALLOW');
  });
  it('PLAYGROUND-CAP the per-class form validates; unknown class keys and non-list values are rejected', () => {
    const text = (m: string) => `version: 1\nrules:\n  - id: custom-r\n    effect: deny\n    priority: 10\n    match: { verb: [create], class: [vpc], region_not_in: ${m} }\n    reason: x\n`;
    expect(parsePolicy(text('{ vpc: [ewr] }'), 'floor').ok).toBe(true);
    expect(parsePolicy(text('{ bogus: [ewr] }'), 'floor').ok).toBe(false);
    expect(parsePolicy(text('{ vpc: ewr }'), 'floor').ok).toBe(false);
  });
});
