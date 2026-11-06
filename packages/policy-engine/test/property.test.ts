// File: packages/policy-engine/test/property.test.ts
import { describe, expect, it } from 'vitest';
import { VERB_CLASS, evaluate, isKnownCall, type CallRequest } from '../src/index.ts';
import { floor, session, state } from './fixtures.ts';

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['list', 'create', 'update', 'delete', 'put', 'restore', 'fetch', 'read', 'write', 'exec', 'drop', ''];
const CLASSES = [...Object.keys(VERB_CLASS), 'database', 'user', 'billing', ''];
const LABELS = [undefined, '', 'plumbline-wk-1', 'plumbline-prod-db', 'plumbline-infra-x', 'plumbline-s9-vault', 'customer-db', 'PLUMBLINE-wk-1', 'plumbline'];
const TAGS = [[], ['protected'], ['Protected'], ['plumbline'], ['protected', 'plumbline']];
const PLANS = [undefined, 'vc2-1c-1gb', 'vc2-1c-0.5gb', 'vc2-64c-256gb', 'x'];
const REGIONS = [undefined, 'ewr', 'lhr', 'ord'];
const TTLS: unknown[] = [undefined, 0, 0.5, 1, 5, 100, Number.NaN, Infinity, -Infinity, -1, '5', null, {}, true];
const RESOLVED = [true, true, false, undefined];
const URLS = [undefined, 'https://evil.example/a', 'https://docs.vultr.com/x', 'garbage', 'http://169.254.169.254/'];

describe('AC-L1-2 property test', () => {
  const rand = rng(20261106);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const iterations = 8000;
  it('AG4-ENG-3 AG4-ENG-4 never ALLOWs outside the catalog, never ALLOWs protected or foreign mutations', () => {
    let allows = 0;
    for (let i = 0; i < iterations; i++) {
      const r: CallRequest = {
        request_id: `p${i}`, task_id: 't', session_id: 's',
        verb: pick(VERBS) as never, class: pick(CLASSES) as never,
        target: { id: 'x', label: pick(LABELS), tags: pick(TAGS), resolved: pick(RESOLVED) },
        caller: pick([undefined, 'sandbox', 'owner'] as const),
        params: { plan: pick(PLANS), region: pick(REGIONS), ttl_h: pick(TTLS) as number, url: pick(URLS), label: pick(LABELS) },
      };
      const s = state({
        kill_switch: rand() < 0.1, live_worker_count: Math.floor(rand() * 6),
        session_spent_usd: rand() * 2, global_spent_usd: rand() * 11,
        session_tier: rand() < 0.2 ? 'observer' : 'standard', rate_card: rand() < 0.1 ? null : state().rate_card,
        object_versions: pick([null, 0, 1, 2, 5]),
      });
      const d = evaluate(r, session, floor, s);
      if (d.decision !== 'ALLOW') continue;
      allows += 1;
      expect(isKnownCall(r.verb, r.class)).toBe(true);
      const mutating = !['list', 'read', 'fetch'].includes(r.verb);
      const label = r.verb === 'create' ? (r.params.label ?? r.target.label) : r.target.label;
      if (mutating && r.class !== 'policy') expect(label?.startsWith('plumbline')).toBe(true);
      if (['delete', 'update'].includes(r.verb) && ['instance', 'firewall_group'].includes(r.class)) {
        expect((r.target.tags ?? []).map((t) => t.toLowerCase())).not.toContain('protected');
        expect(label?.startsWith('plumbline-prod-') || label?.startsWith('plumbline-infra-')).toBe(false);
      }
      if (s.kill_switch) expect(mutating).toBe(false);
      // AG4-ENG-2: an unresolved target is never ALLOWed for update/delete/put/restore.
      if (['update', 'delete', 'put', 'restore'].includes(r.verb) && r.class !== 'policy') expect(r.target.resolved).toBe(true);
      // AG4-ENG-3: no ALLOW carries a non-finite, non-positive or non-number ttl_h.
      if (r.params.ttl_h !== undefined) expect(Number.isFinite(r.params.ttl_h) && r.params.ttl_h > 0).toBe(true);
      // AG4-ENG-4: an unknown version count never ALLOWs a bucket delete.
      if (r.verb === 'delete' && r.class === 'bucket_object') expect(s.object_versions).not.toBeNull();
      // AG4-BRK-7: no ALLOWed policy write without the owner flag.
      if (r.verb === 'write' && r.class === 'policy') expect(r.caller).toBe('owner');
    }
    expect(allows).toBeGreaterThan(50);
  });
  it('every decision is deterministic for the same input', () => {
    const r: CallRequest = { request_id: 'd', task_id: 't', session_id: 's', verb: 'delete', class: 'instance', target: { id: 'a', label: 'plumbline-wk-1', tags: [] }, params: {} };
    const a = evaluate(r, session, floor, state());
    const b = evaluate(r, session, floor, state());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
