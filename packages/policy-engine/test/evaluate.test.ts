// File: packages/policy-engine/test/evaluate.test.ts
import { describe, expect, it } from 'vitest';
import { approveEscalation, assertAllow, evaluate, isGenuineAllow, parsePolicy } from '../src/index.ts';
import { floor, prodDb, req, session, state, vault, worker } from './fixtures.ts';

const run = (r: ReturnType<typeof req>, s = state()) => evaluate(r, session, floor, s);

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

describe('floor layer', () => {
  it('floor-prod-immutable fires even when the session copy is weakened', () => {
    const weak = parsePolicy('version: 2\nrules:\n  - id: custom-allow-all\n    effect: allow\n    priority: 1\n    match: { verb: [delete], class: [instance] }\n    reason: judge edit\n', 'session');
    if (!weak.ok) throw new Error('weak policy invalid');
    const d = evaluate(req({ verb: 'delete', class: 'instance', target: { id: 'i', label: 'plumbline-prod-db', tags: [] } }), weak.policy, floor, state());
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('floor-prod-immutable');
    expect(d.layer).toBe('floor');
  });
  it('floor-prod-immutable does not fire on a worker', () => {
    expect(run(req({ verb: 'delete', class: 'instance', target: worker })).decision).toBe('ALLOW');
  });
  it('infra labels are floor-protected', () => {
    const d = run(req({ verb: 'delete', class: 'instance', target: { id: 'i', label: 'plumbline-infra-broker', tags: [] } }));
    expect(d.rule_id).toBe('floor-prod-immutable');
  });
  it('kill-switch-engaged denies every mutating verb and not list', () => {
    expect(run(req({ verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } }), state({ kill_switch: true })).rule_id).toBe('kill-switch-engaged');
    expect(run(req({ verb: 'list', class: 'instance' }), state({ kill_switch: true })).decision).toBe('ALLOW');
  });
  it('scope-label-prefix fires on foreign labels and unresolved ids', () => {
    expect(run(req({ verb: 'delete', class: 'instance', target: { id: 'zz', label: 'customer-db', tags: [] } })).rule_id).toBe('scope-label-prefix');
    expect(run(req({ verb: 'delete', class: 'instance', target: { id: 'unknown' } })).rule_id).toBe('scope-label-prefix');
  });
  it('egress-allowlist fires on a foreign host and not on an allowed one', () => {
    expect(run(req({ verb: 'fetch', class: 'http', params: { url: 'https://evil.example/x' } })).rule_id).toBe('egress-allowlist');
    expect(run(req({ verb: 'fetch', class: 'http', params: { url: 'https://docs.vultr.com/a' } })).decision).toBe('ALLOW');
    expect(run(req({ verb: 'fetch', class: 'http', params: { url: 'not a url' } })).rule_id).toBe('egress-allowlist');
  });
  it('acl-tier-denied and tier-key-unavailable', () => {
    const create = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-1' } });
    expect(run(create, state({ session_tier: 'observer' })).rule_id).toBe('acl-tier-denied');
    expect(run(create, state({ tier_available: { observer: true, deployer: false, network: true, objstore: true, registry: true } })).rule_id).toBe('tier-key-unavailable');
    expect(run(create).decision).toBe('ALLOW');
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
  it('a foreign label on create is default-deny, not allow', () => {
    const r = req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-other' } });
    expect(run(r).rule_id).toBe('default-deny');
  });
});

describe('rewind and bond rules', () => {
  const del = req({ verb: 'delete', class: 'bucket_object', target: { id: 'orders.json', label: 'plumbline-orders-db', tags: [] } });
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
    expect(() => assertAllow(forged)).toThrow('NOT_AN_ENGINE_ALLOW');
    const d = run(req({ verb: 'list', class: 'instance' }));
    expect(isGenuineAllow(d)).toBe(true);
  });
  it('decisions are frozen', () => {
    const d = run(req({ verb: 'list', class: 'instance' }));
    expect(() => { (d as { rule_id: string }).rule_id = 'x'; }).toThrow();
  });
});

describe('hot-edit flip (F2)', () => {
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
  it('the session playground flips to ESCALATE and approval yields an engine ALLOW', () => {
    const d = evaluate(req({ verb: 'delete', class: 'firewall_group', target: vault }), flipped, floor, state());
    expect(d.decision).toBe('ESCALATE');
    if (d.decision !== 'ESCALATE') return;
    expect(isGenuineAllow(approveEscalation(d))).toBe(true);
  });
  it('the same edit cannot flip plumbline-prod-db and a floor deny cannot be approved', () => {
    const d = evaluate(req({ verb: 'delete', class: 'instance', target: prodDb }), flipped, floor, state());
    expect(d.decision).toBe('DENY');
    expect(d.rule_id).toBe('floor-prod-immutable');
    expect(() => approveEscalation(d as never)).toThrow();
  });
});
