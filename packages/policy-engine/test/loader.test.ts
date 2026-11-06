// File: packages/policy-engine/test/loader.test.ts
import { describe, expect, it } from 'vitest';
import { diffRules, parsePolicy, validatePolicy } from '../src/index.ts';
import { session } from './fixtures.ts';

describe('policy loader', () => {
  it('loads the shipped session default and floor', () => {
    expect(session.rules.length).toBeGreaterThan(10);
    expect(session.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('reports a line number for a bad effect', () => {
    const r = validatePolicy('version: 1\nrules:\n  - id: protect-tagged-destroy\n    effect: maybe\n    priority: 1\n    match: { verb: [delete] }\n    reason: x\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.line).toBe(4);
  });
  it('rejects unknown keys, unknown rule ids and duplicate ids', () => {
    expect(validatePolicy('version: 1\nrules:\n  - id: nope\n    effect: deny\n    priority: 1\n    match: {}\n    reason: x\n').ok).toBe(false);
    expect(validatePolicy('version: 1\nextra: 1\nrules: []\n').ok).toBe(false);
    const dup = 'version: 1\nrules:\n  - {id: custom-a, effect: deny, priority: 1, match: {}, reason: x}\n  - {id: custom-a, effect: deny, priority: 1, match: {}, reason: x}\n';
    expect(validatePolicy(dup).ok).toBe(false);
  });
  it('rejects yaml syntax errors and oversized input without throwing', () => {
    expect(validatePolicy('rules: [').ok).toBe(false);
    expect(validatePolicy('a'.repeat(70000)).ok).toBe(false);
  });
  it('reload takes well under one second', () => {
    const t0 = performance.now();
    parsePolicy(JSON.stringify({ version: 1, rules: session.rules }), 'session');
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  it('diff names changed effects', () => {
    const changed = { ...session, rules: session.rules.map((r) => (r.id === 'protect-tagged-destroy' ? { ...r, effect: 'escalate' as const } : r)) };
    expect(diffRules(session, changed)).toContain('~ changed protect-tagged-destroy: effect deny -> escalate');
  });
});
