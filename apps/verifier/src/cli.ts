#!/usr/bin/env -S npx tsx
// File: apps/verifier/src/cli.ts
// USER-ONBOARDING AUDITOR: `plumbline-verify --ledger ledger.json --baseline baseline.json --expect-head <hex>` with an environment variable
// holding a view-only key; the CLI writes nothing to Vultr. Exit code 0 GREEN, 1 RED, 2 DEGRADED.
// AG4-VER-6: without --baseline the verdict can never be GREEN (weak mode), and an --ledger without --expect-head is UNVERIFIED
// (a self-consistent forged file would pass), so it cannot be GREEN either. The export chain and freshness are always verified.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '@plumbline/policy-engine';
import { reconcile, type BaselineEntry, type LedgerExport, type Report } from './reconcile.ts';
import { loadBaseline } from './sharedFiles.ts';
import { makeHttp, snapshot, type Snapshot } from './vultr-lite.ts';

const USAGE = 'usage: PLUMBLINE_VERIFY_KEY=<view-only key> plumbline-verify --ledger ledger.json [--baseline baseline.json] [--expect-head <sha256 hex>] [--floor floor.yaml] [--max-age-s 300]\n'
  + '  exit 0 GREEN, 1 RED, 2 DEGRADED (a missing baseline or an unpinned ledger can never be GREEN)\n';
const DEFAULT_FLOOR = fileURLToPath(new URL('../../../policy/floor.yaml', import.meta.url));

export function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadFloorFile(path: string) {
  try {
    const r = parsePolicy(readFileSync(path, 'utf8'), 'floor');
    return r.ok ? r.policy : null;
  } catch {
    return null;
  }
}

/** The weak mode: owner-declared prefixes taken from the live list itself (so the look-alike problem is explicit in the output) */
export function deriveBaseline(p: Snapshot): BaselineEntry[] {
  if (!p.ok) return [];
  return p.live.filter((l) => l.label.startsWith('plumbline-infra-') || l.label.startsWith('plumbline-prod-'))
    .map((l) => ({ id: l.id, class: l.class, label: l.label, plan: l.plan, region: l.region, power_status: l.power_status, os: l.os }));
}

export interface CliOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export async function runCli(o: CliOptions): Promise<{ code: number; report?: Report; mode?: string; out: string }> {
  const key = o.env.PLUMBLINE_VERIFY_KEY;
  const ledgerPath = argOf(o.argv, 'ledger');
  if (o.argv.includes('--help')) return { code: 0, out: USAGE };
  if (!key || !ledgerPath) return { code: 2, out: USAGE };
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerExport;
  const http = makeHttp(key, o.fetchImpl);
  const p1 = await snapshot(http, clock);
  await sleep(3000);
  const p2 = await snapshot(http, clock);
  const baselinePath = argOf(o.argv, 'baseline');
  const head = argOf(o.argv, 'expect-head');
  const manifest = baselinePath ? loadBaseline(baselinePath) : null;
  const derived = !baselinePath;
  const report = reconcile({
    poll1: p1, poll2: p2, ledger, baseline: derived ? deriveBaseline(p2) : manifest, baselineMode: derived ? 'derived' : 'manifest',
    watchdogDestroyed: [], floor: loadFloorFile(argOf(o.argv, 'floor') ?? DEFAULT_FLOOR), now: clock(),
    ledgerTrust: head ? 'pinned' : 'unverified', expectHead: head, exportMayPrecedePolls: true,
    maxExportAgeMs: Number(argOf(o.argv, 'max-age-s') ?? 300) * 1000, host: hostname(),
  });
  const mode = derived ? 'weak: owner-declared prefixes plumbline-infra- and plumbline-prod- (pass --baseline for the strong mode)' : 'baseline manifest';
  const code = report.status === 'GREEN' ? 0 : report.status === 'RED' ? 1 : 2;
  return { code, report, mode, out: `${JSON.stringify({ mode, ...report }, null, 2)}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await runCli({ argv: process.argv.slice(2), env: process.env });
  (r.code === 2 && !r.report ? process.stderr : process.stdout).write(r.out);
  process.exit(r.code);
}
