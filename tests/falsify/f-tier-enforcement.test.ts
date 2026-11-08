// FALSIFY (f): an observer-tier session cannot do what a standard session can.
// Delete acl-tier-denied / the tier_insufficient check and these go RED.
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../packages/policy-engine/src/index.ts';
import { allowAllSession, floor, req, session, state, worker } from '../../packages/policy-engine/test/fixtures.ts';
import { makeBroker } from '../../apps/broker/test/support.ts';

const create = () => req({ verb: 'create', class: 'instance', params: { plan: 'vc2-1c-1gb', region: 'ewr', ttl_h: 1, label: 'plumbline-wk-1' } });
const del = () => req({ verb: 'delete', class: 'instance', target: worker });

describe('FALSIFY (f) tier enforcement', () => {
  it.each([['create', create], ['delete', del]] as const)('%s: standard ALLOW, observer DENY acl-tier-denied (also with an allow-all session)', (_n, mk) => {
    expect(evaluate(mk(), session, floor, state({ session_tier: 'standard' })).decision).toBe('ALLOW');
    for (const sess of [session, allowAllSession]) {
      const d = evaluate(mk(), sess, floor, state({ session_tier: 'observer' }));
      expect([d.decision, d.rule_id]).toEqual(['DENY', 'acl-tier-denied']);
    }
  });
  it('control: observer may still read (list), so the denial is mutation-specific', () => {
    expect(evaluate(req({ verb: 'list', class: 'instance' }), session, floor, state({ session_tier: 'observer' })).decision).toBe('ALLOW');
  });
  it('an unavailable tier key for a standard session fails closed rather than falling back to a stronger key', () => {
    const d = evaluate(create(), allowAllSession, floor, state({ tier_available: { observer: true, deployer: false, network: true, objstore: true, registry: true } }));
    expect([d.decision, d.rule_id]).toEqual(['DENY', 'tier-key-unavailable']);
  });
  it('broker: after the session is set to observer, a worker create is DENY and never POSTs to Vultr; a standard session creates', async () => {
    const { app, mock } = await makeBroker();
    const sid = (await app.internal.inject({ method: 'POST', url: '/v1/session', headers: { 'x-plumbline-api-token': 'api-token-test' }, payload: {} })).json().session_id as string;
    const std = await app.pipeline.handleCall({ task_id: 't1', session_id: sid }, { verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-aaaa' } });
    expect(std.status === 'DECIDED' && std.decision.decision).toBe('ALLOW');
    const posts = () => mock.state.calls.filter((c) => c.method === 'POST').length;
    const before = posts();
    const set = await app.internal.inject({ method: 'POST', url: `/v1/session/${sid}/tier`, headers: { 'x-plumbline-api-token': 'api-token-test' }, payload: { tier: 'observer' } });
    expect(set.statusCode).toBe(200);
    const obs = await app.pipeline.handleCall({ task_id: 't2', session_id: sid }, { verb: 'create', class: 'instance', target: {}, params: { plan: 'vc2-1c-1gb', region: 'ewr', label: 'plumbline-wk-bbbb' } });
    expect(obs.status).toBe('DECIDED');
    if (obs.status !== 'DECIDED') return;
    expect([obs.decision.decision, obs.decision.rule_id]).toEqual(['DENY', 'acl-tier-denied']);
    expect(posts()).toBe(before);
  });
});
