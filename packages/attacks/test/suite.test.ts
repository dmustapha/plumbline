// File: packages/attacks/test/suite.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '@plumbline/policy-engine';
import { loadFixtures, runEngineSuite } from '../src/index.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pol = (f: string, l: 'session' | 'floor') => { const r = parsePolicy(readFileSync(`${root}policy/${f}`, 'utf8'), l); if (!r.ok) throw new Error('bad'); return r.policy; };

describe('attack library', () => {
  const fixtures = loadFixtures(`${root}attacks`);
  it('ships at least 30 fixtures over the ten groups of PRD 4.16', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(new Set(fixtures.map((f) => f.group)).size).toBe(10);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
  });
  it('every engine-mode fixture passes against the shipped policies with zero breaches', () => {
    const report = runEngineSuite(fixtures, pol('session-default.yaml', 'session'), pol('floor.yaml', 'floor'));
    expect(report.failed).toBe(0);
    expect(report.breaches).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(23);
    expect(report.deferred).toBe(fixtures.length - report.passed);
  });
  it('H-1 and AG4-PRD-1: the registry, unresolved-target, ttl, policy-write and unknown-state fixtures hold', () => {
    const report = runEngineSuite(fixtures, pol('session-default.yaml', 'session'), pol('floor.yaml', 'floor'));
    const byId = new Map(report.results.map((r) => [r.id, r]));
    for (const id of ['se-5', 'se-6', 'se-7', 'se-8', 'pt-4', 'pt-5', 'oc-6', 'oc-7', 'oc-8', 'rwd-3']) {
      expect(byId.get(id)?.verdict, id).toBe('pass');
    }
    expect(byId.get('se-5')?.got).toEqual({ decision: 'DENY', rule_id: 'floor-registry-shared' });
  });
  it('AG4-PRD-1 every floor-owned fixture still holds with the session layer reduced to allow-all (floor alone)', () => {
    const allowAll = { version: 1, layer: 'session' as const, hash: 'aa', rules: [{ id: 'custom-allow-all', effect: 'allow' as const, priority: 1, match: {}, reason: 'weak' }] };
    const report = runEngineSuite(fixtures, allowAll, pol('floor.yaml', 'floor'));
    const floorOnly = ['se-5', 'se-7', 'se-8', 'pt-4', 'pt-5', 'oc-1', 'oc-2', 'oc-3', 'oc-4', 'oc-5', 'oc-6', 'oc-7', 'oc-8', 'se-1', 'se-2', 'se-3', 'se-4', 'ex-1', 'ex-2'];
    const byId = new Map(report.results.map((r) => [r.id, r]));
    for (const id of floorOnly) expect(byId.get(id)?.verdict, id).toBe('pass');
  });
  it('the Destroy-protected group is entirely protect-tagged-destroy', () => {
    const dp = fixtures.filter((f) => f.group === 'destroy-protected');
    expect(dp).toHaveLength(6);
    expect(dp.every((f) => f.expect_rule_id === 'protect-tagged-destroy')).toBe(true);
  });
});
