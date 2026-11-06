import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '@plumbline/policy-engine';
import { loadFixtures, runEngineSuite } from '@plumbline/attacks';

const root = fileURLToPath(new URL('../', import.meta.url));
const pol = (f: string, l: 'session' | 'floor') => { const r = parsePolicy(readFileSync(`${root}policy/${f}`, 'utf8'), l); if (!r.ok) throw new Error('bad policy'); return r.policy; };

describe('G1d tier-violation fixtures', () => {
  it('tv-1..tv-7 all pass against the shipped policies and none is an ALLOW', () => {
    const fx = loadFixtures(`${root}attacks`).filter((f) => f.group === 'tier-violation');
    expect(fx.map((f) => f.id)).toEqual(['tv-1', 'tv-2', 'tv-3', 'tv-4', 'tv-5', 'tv-6', 'tv-7']);
    const report = runEngineSuite(fx, pol('session-default.yaml', 'session'), pol('floor.yaml', 'floor'));
    expect(report.results.map((r) => r.verdict)).toEqual(Array(7).fill('pass'));
  });
});
