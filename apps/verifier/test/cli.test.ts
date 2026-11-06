import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { argOf, deriveBaseline, runCli } from '../src/cli.ts';
import type { LiveResource } from '../src/vultr-lite.ts';
import { BASELINE, INFRA, T, healthy, live, snap } from './support.ts';

const raw = (l: LiveResource) => (l.class === 'instance'
  ? { id: l.id, label: l.label, status: l.status, power_status: l.power_status, plan: l.plan, region: l.region, os: l.os }
  : { id: l.id, name: l.label, description: l.label, region: l.region });

function setup(extra: LiveResource[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'plb-cli-'));
  const f = healthy();
  const ledger = join(dir, 'ledger.json');
  const e = f.export(T + 3500);
  writeFileSync(ledger, JSON.stringify(e));
  const baseline = join(dir, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ resources: BASELINE }));
  const all = [...INFRA, ...extra];
  const fetchImpl = (async (u: string) => {
    const key = new URL(u).pathname.replace('/v2/', '') as 'instances' | 'vpcs' | 'registries';
    const cls = { instances: 'instance', vpcs: 'vpc', registries: 'registry' }[key];
    return new Response(JSON.stringify({ [key]: all.filter((l) => l.class === cls).map(raw) }));
  }) as unknown as typeof fetch;
  const run = (args: string[]) => runCli({ argv: args, env: { PLUMBLINE_VERIFY_KEY: 'k' }, fetchImpl, sleep: async () => undefined, clock: () => T + 3600 });
  return { ledger, baseline, head: e.chain_head, run };
}

describe('plumbline-verify CLI', () => {
  it('--help prints usage and exits 0; missing args exit 2', async () => {
    const s = setup();
    expect(await s.run(['--help'])).toMatchObject({ code: 0, out: expect.stringContaining('usage:') });
    expect((await s.run([])).code).toBe(2);
    expect(await runCli({ argv: ['--ledger', s.ledger], env: {} })).toMatchObject({ code: 2 });
  });

  it('strong mode (baseline + pinned head) is GREEN, exit 0', async () => {
    const s = setup();
    const r = await s.run(['--ledger', s.ledger, '--baseline', s.baseline, '--expect-head', s.head]);
    expect(r).toMatchObject({ code: 0, report: { status: 'GREEN', ledger: { trust: 'pinned' } } });
  });

  it('AG4-VER-6: without --baseline the result is never GREEN (DEGRADED, exit 2) and the mode is printed', async () => {
    const s = setup();
    const r = await s.run(['--ledger', s.ledger, '--expect-head', s.head]);
    expect(r.code).toBe(2);
    expect(r.report?.status).toBe('DEGRADED');
    expect(r.out).toContain('weak');
  });

  it('AG4-VER-6: an unsigned --ledger (no --expect-head) is unverified, never GREEN', async () => {
    const s = setup();
    const r = await s.run(['--ledger', s.ledger, '--baseline', s.baseline]);
    expect(r).toMatchObject({ code: 2, report: { status: 'DEGRADED', ledger: { trust: 'unverified' } } });
  });

  it('a wrong pinned head is RED (the file is not the ledger the owner pinned), exit 1', async () => {
    const s = setup();
    const r = await s.run(['--ledger', s.ledger, '--baseline', s.baseline, '--expect-head', 'f'.repeat(64)]);
    expect(r).toMatchObject({ code: 1, report: { codes: ['RECONCILE_RED_LEDGER_TAMPERED'] } });
  });

  it('an unlogged instance is RED, exit 1, even in weak mode', async () => {
    const s = setup([live({ id: 'i-rogue', label: 'oops' })]);
    expect((await s.run(['--ledger', s.ledger])).code).toBe(1);
    expect((await s.run(['--ledger', s.ledger, '--baseline', s.baseline, '--expect-head', s.head])).report?.findings[0]?.resource_id).toBe('i-rogue');
  });

  it('a missing baseline file is DEGRADED', async () => {
    const s = setup();
    expect((await s.run(['--ledger', s.ledger, '--baseline', '/nonexistent.json', '--expect-head', s.head])).code).toBe(2);
  });

  it('argOf and deriveBaseline', () => {
    expect(argOf(['--a', 'x'], 'a')).toBe('x');
    expect(argOf(['--a'], 'b')).toBeUndefined();
    expect(deriveBaseline(snap(INFRA)).map((b) => b.label)).toEqual(['plumbline-prod-db', 'plumbline-infra-broker']);
    expect(deriveBaseline({ ok: false, at: 1, error: 'x' })).toEqual([]);
  });
});
