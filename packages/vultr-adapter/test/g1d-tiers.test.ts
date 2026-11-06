import { describe, expect, it } from 'vitest';
import { Ledger, openDb } from '@plumbline/ledger';
import { tierFor } from '@plumbline/policy-engine';
import { TIER_ACL, TierKeys } from '../src/index.ts';
import { createMockVultr } from './support/mock-vultr.ts';

const ledger = () => new Ledger(openDb(':memory:'), { session_ceiling_usd: 1.5, global_cap_usd: 10 });
const viewOnly = (m: string): boolean => m === 'GET';

describe('G1d GATE-L4 mock proof (PLAN 2d.2 / 2d.3)', () => {
  it('PLAN-2d.2 result [0] is the observer create refused 403 with the Vultr body, result [1] is the observer list 200', async () => {
    const mock = createMockVultr({ acl: { o: viewOnly } });
    const rows = await new TierKeys({ observer: 'o', deployer: null, network: null, registry: null }, ledger(), mock.fetch).aclSelfTest('gate');
    expect(rows[0]).toMatchObject({ tier: 'observer', call: 'POST /instances', status: 403, ok: true });
    expect(JSON.stringify(rows[0]?.body)).toContain('Permission denied');
    expect(rows[1]).toMatchObject({ tier: 'observer', call: 'GET /instances', status: 200, ok: true });
    expect(mock.state.instances).toHaveLength(0);
  });
  it('an observer key that can create is reported as a failure (never a pass)', async () => {
    const mock = createMockVultr();
    const rows = await new TierKeys({ observer: 'o', deployer: null, network: null, registry: null }, ledger(), mock.fetch).aclSelfTest('gate');
    expect(rows.filter((r) => !r.ok).length).toBeGreaterThan(0);
  });
  it('E-2: the playground VPC is made with the deployer tier, whose ACL the watchdog also holds', () => {
    expect(tierFor('create', 'vpc')).toBe('deployer');
    expect(TIER_ACL.deployer).toBe('provisioning');
    expect(tierFor('delete', 'vpc')).toBe('deployer');
  });
  it('DT-19: an IP-locked tier (401) goes down and is not replaced by a stronger key', async () => {
    const mock = createMockVultr({ unauthorizedKeys: ['d'] });
    const tiers = new TierKeys({ observer: 'o', deployer: 'd', network: null, registry: null }, ledger(), mock.fetch);
    await tiers.aclSelfTest('gate');
    expect(tiers.availability().deployer).toBe(false);
    expect(() => tiers.http('deployer')).toThrow('tier-key-unavailable');
  });
});
