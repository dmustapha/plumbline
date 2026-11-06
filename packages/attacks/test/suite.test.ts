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
  it('the Destroy-protected group is entirely protect-tagged-destroy', () => {
    const dp = fixtures.filter((f) => f.group === 'destroy-protected');
    expect(dp).toHaveLength(6);
    expect(dp.every((f) => f.expect_rule_id === 'protect-tagged-destroy')).toBe(true);
  });
});
