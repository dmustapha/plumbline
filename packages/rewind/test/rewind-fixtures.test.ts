import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '@plumbline/policy-engine';
import { loadFixtures, runEngineSuite } from '@plumbline/attacks';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pol = (f: string, l: 'session' | 'floor') => { const r = parsePolicy(readFileSync(`${root}policy/${f}`, 'utf8'), l); if (!r.ok) throw new Error('bad'); return r.policy; };

describe('G1f rewind fixtures', () => {
  const rewind = loadFixtures(`${root}attacks`).filter((f) => f.group === 'rewind');
  const report = runEngineSuite(rewind, pol('session-default.yaml', 'session'), pol('floor.yaml', 'floor'));
  it('last-copy delete ESCALATEs, an unknown count is DENIED, a reversible delete is ALLOWED', () => {
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get('rwd-1')?.got).toEqual({ decision: 'ESCALATE', rule_id: 'last-copy-block' });
    expect(byId.get('rwd-2')?.got).toEqual({ decision: 'ALLOW', rule_id: 'allow-bucket-ops' });
    expect(byId.get('rwd-3')?.got).toEqual({ decision: 'DENY', rule_id: 'object-state-unknown' });
  });
  it('AG4-PRD-6 per-session canary keys are judged exactly like the shared key', () => {
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get('rwd-4')?.got).toEqual({ decision: 'ESCALATE', rule_id: 'last-copy-block' });
    expect(byId.get('rwd-5')?.got).toEqual({ decision: 'ESCALATE', rule_id: 'last-copy-block' });
    expect(byId.get('rwd-6')?.got).toEqual({ decision: 'ALLOW', rule_id: 'allow-bucket-ops' });
  });
  it('every rewind fixture passes with zero breaches', () => {
    expect(rewind).toHaveLength(6);
    expect(report.failed).toBe(0);
    expect(report.breaches).toBe(0);
    expect(report.passed).toBe(6);
  });
});
