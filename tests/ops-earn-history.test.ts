import { describe, expect, it } from 'vitest';
import type { Fixture } from '@plumbline/attacks';
import { earnHistory, makeAttacker, postWithBackoff, summaryLine, type HistoryDeps } from '../ops/scripts/earn-history.ts';

interface Calls { posts: { path: string; body: any }[]; sleeps: number[] }

function deps(handler: (path: string, body: any, n: number) => { status: number; json: any }, rows: () => any[] = () => []): { d: HistoryDeps; c: Calls } {
  const c: Calls = { posts: [], sleeps: [] };
  let t = 10_000; let n = 0;
  const d: HistoryDeps = {
    base: 'https://x.sslip.io', now: () => t, sleep: async (ms) => { c.sleeps.push(ms); t += ms; },
    fetchJson: async (path, init) => {
      if (init?.method === 'POST') { c.posts.push({ path, body: init.body }); n += 1; return handler(path, init.body, n); }
      return { status: 200, json: rows() };
    },
  };
  return { d, c };
}
const fx = (id: string, rule: string, expect_decision: Fixture['expect_decision'] = 'DENY'): Fixture => ({ id, group: 'g', text: `attack ${id}`, expect_decision, expect_rule_id: rule, request: { verb: 'delete', class: 'instance' } });
const ok = (path: string) => (path === '/api/session' ? { status: 200, json: { session_id: 'a1b2c3d4' } } : { status: 202, json: {} });

describe('earn-history', () => {
  it('fires each fixture through /api/attack and computes the summary from observed rows', async () => {
    const rows: any[] = [];
    const { d, c } = deps((p, b) => { if (p === '/api/attack') rows.push({ ts: 20_000, session_id: 'a1b2c3d4', rule_id: 'protect-tagged-destroy', decision: 'DENY' }); return ok(p); }, () => rows);
    const rep = await earnHistory(d, [fx('a', 'protect-tagged-destroy'), fx('b', 'protect-tagged-destroy')]);
    expect(rep).toMatchObject({ run: 2, matched: 2, refused: 0, breaches: 0, base: 'https://x.sslip.io' });
    expect(summaryLine(rep)).toMatch(/^2 attacks, 0 breaches/);
    expect(c.posts.filter((p) => p.path === '/api/attack')).toHaveLength(2);
  });
  it('a fresh session after every three attacks (the 3-per-minute limit applies to the script too)', async () => {
    const { d, c } = deps((p) => ok(p), () => [{ ts: 99_999_999, session_id: 'a1b2c3d4', rule_id: 'r', decision: 'DENY' }]);
    const attack = makeAttacker(d);
    for (let i = 0; i < 4; i++) await attack(fx(String(i), 'r'));
    expect(c.posts.filter((p) => p.path === '/api/session')).toHaveLength(2);
  });
  it('records an unobserved attack as refused instead of inventing a row, and counts an ALLOW as a breach', async () => {
    const none = deps((p) => ok(p), () => []);
    const r1 = await earnHistory(none.d, [fx('x', 'r')]);
    expect(r1).toMatchObject({ run: 1, refused: 1, matched: 0, breaches: 0 });
    const allow = deps((p) => ok(p), () => [{ ts: 99_999_999, session_id: 'a1b2c3d4', rule_id: 'allow-list', decision: 'ALLOW' }]);
    expect(await earnHistory(allow.d, [fx('y', 'protect-tagged-destroy')])).toMatchObject({ breaches: 1 });
  });
  it('ignores rows from other sessions', async () => {
    const { d } = deps((p) => ok(p), () => [{ ts: 99_999_999, session_id: 'ffffffff', rule_id: 'r', decision: 'ALLOW' }]);
    expect(await earnHistory(d, [fx('z', 'r')])).toMatchObject({ refused: 1, breaches: 0 });
  });
  it('waits out a 429 with the server retry_after_s, bounded, then gives up', async () => {
    const { d, c } = deps(() => ({ status: 429, json: { retry_after_s: 7 } }));
    const r = await postWithBackoff(d, '/api/session', {});
    expect(r.status).toBe(429);
    expect(c.sleeps).toEqual([7000, 7000, 7000, 7000]);
    expect(c.posts).toHaveLength(5);
  });
  it('a refused attack POST (non-202) is recorded as refused', async () => {
    const { d } = deps((p) => (p === '/api/session' ? ok(p) : { status: 400, json: {} }));
    expect(await earnHistory(d, [fx('q', 'r')])).toMatchObject({ refused: 1 });
  });
});
