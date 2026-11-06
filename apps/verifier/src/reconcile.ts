// File: apps/verifier/src/reconcile.ts
// INVARIANT 3 and PRD C9 codes. Pure: all I/O (Vultr, ledger export, baseline, watchdog log, floor) is done by the caller.
// A finding must hold in BOTH polls; any poll, export, baseline or floor problem is DEGRADED, never GREEN.
import { verifyExport, type ExportResource, type LedgerExport } from '@plumbline/ledger';
import type { PolicyDoc } from '@plumbline/policy-engine';
import { replayLive } from './replay.ts';
import type { LiveResource, Snapshot } from './vultr-lite.ts';

export type { LedgerExport } from '@plumbline/ledger';

export interface BaselineEntry {
  id: string;
  class: 'instance' | 'vpc' | 'registry';
  label: string;
  plan: string;
  region: string;
  /** required for instances (CO-2 H-3) */
  power_status?: string;
  os?: string;
}

export type Code =
  | 'RECONCILE_RED_UNLOGGED' | 'RECONCILE_RED_MISSING' | 'RECONCILE_RED_PROTECTED_CHANGED'
  | 'RECONCILE_RED_POLICY_VIOLATION' | 'RECONCILE_RED_LEDGER_TAMPERED' | 'RECONCILE_DEGRADED';

export interface Finding {
  code: Code;
  resource_id: string;
  class: string;
  detail: string;
}

export interface DestroyedEntry {
  id: string;
  ts: number;
}

/** the last decision the verifier verified: a later export must still contain it unchanged (append-only continuity) */
export interface Pin {
  seq: number;
  row_hash: string;
}

export type LedgerTrust = 'fetched' | 'pinned' | 'unverified';

export interface ProdDbRead {
  found: boolean;
  id: string | null;
  label: string;
  status: string | null;
  power_status: string | null;
  plan: string | null;
  region: string | null;
  os: string | null;
  read_at: number;
  read_by: string;
}

export interface Report {
  status: 'GREEN' | 'RED' | 'DEGRADED';
  codes: Code[];
  findings: Finding[];
  counts: { live: number; baseline: number; ledger_rows: number; decisions: number; allow: number; deny: number; escalate: number; unauthorized: number; unknown_outcomes: number };
  polls: number[];
  polled_twice: boolean;
  coverage: string[];
  not_covered: string[];
  limits: string;
  ledger: { trust: LedgerTrust; head: string | null; generated_at: number | null; pin: Pin | null };
  prod_db: ProdDbRead;
  notes: string[];
  verifier_host: string;
  generated_at: number;
}

export interface ReconcileInput {
  poll1: Snapshot;
  poll2: Snapshot;
  ledger: LedgerExport | null;
  ledgerError?: string;
  /** null = missing or unparseable (AG4-VER-8) */
  baseline: BaselineEntry[] | null;
  /** 'derived' = guessed from live labels (CLI without --baseline): the strongest verdict is then DEGRADED (AG4-VER-6) */
  baselineMode?: 'manifest' | 'derived';
  watchdogDestroyed: DestroyedEntry[];
  /** the production floor; null = unavailable, so E-1 cannot run and the verdict is DEGRADED */
  floor: PolicyDoc | null;
  now: number;
  ledgerTrust: LedgerTrust;
  maxExportAgeMs?: number;
  /** auditor CLI: the export file was downloaded before the polls, so do not insist it postdates them */
  exportMayPrecedePolls?: boolean;
  expectHead?: string;
  continuity?: Pin | null;
  host?: string;
  notes?: string[];
}

export const PROD_DB_LABEL = 'plumbline-prod-db';
const COVERAGE = ['instance', 'vpc', 'registry'];
const NOT_COVERED = [
  'firewall_group (the view-only key gets 403 on /firewalls)',
  'bucket (the view-only key gets 403 on /object-storage)',
  'dollar ceiling and session spend (the export carries no session state; plan, region, label and scope rules are replayed on live state)',
];
const LIMITS = 'point-in-time: a resource created and destroyed between two polls is not seen (destroy is visible within 0.8 s)';
/** a ledger row and a Vultr listing are written by two hosts a moment apart: inside this window neither side counts as wrong */
export const INFLIGHT_GRACE_MS = 5000;

interface Ctx {
  baseline: BaselineEntry[];
  rows: Map<string, ExportResource>;
  decisions: Map<string, string>;
  destroyed: DestroyedEntry[];
  floor: PolicyDoc;
  now: number;
}

const finding = (code: Code, l: { id: string; class: string }, detail: string): Finding => ({ code, resource_id: l.id, class: l.class, detail });

function baselineDiff(b: BaselineEntry, l: LiveResource): string | null {
  const d: string[] = [];
  if (b.label !== l.label) d.push(`label ${b.label} -> ${l.label}`);
  if (b.plan !== '' && b.plan !== l.plan) d.push(`plan ${b.plan} -> ${l.plan}`);
  if (b.region !== l.region) d.push(`region ${b.region} -> ${l.region}`);
  if (b.class === 'instance' && b.power_status !== l.power_status) d.push(`power_status ${b.power_status} -> ${l.power_status}`);
  if (b.class === 'instance' && b.os !== l.os) d.push(`os ${b.os} -> ${l.os}`);
  return d.length > 0 ? d.join(', ') : null;
}

function ledgerFindings(l: LiveResource, c: Ctx, at: number): Finding[] {
  const row = c.rows.get(l.id);
  if (!row || !row.allow_decision_id) return [finding('RECONCILE_RED_UNLOGGED', l, `${l.label} exists in Vultr with no ALLOW row in the ledger`)];
  if (c.decisions.get(row.allow_decision_id) !== 'ALLOW') return [finding('RECONCILE_RED_UNLOGGED', l, `${l.label} cites ${row.allow_decision_id}, which is not an ALLOW decision in the export`)];
  if (row.destroyed_at_ms !== null) {
    return at - row.destroyed_at_ms < INFLIGHT_GRACE_MS ? [] : [finding('RECONCILE_RED_UNLOGGED', l, `${l.label} is live but the ledger says it was destroyed`)];
  }
  const v = replayLive(c.floor, l, row, c.now);
  return v ? [finding('RECONCILE_RED_POLICY_VIOLATION', l, `${l.label}: ${v.detail}`)] : [];
}

/** AG4-VER-4: the watchdog log excuses a missing resource only for a destroy at or after the ALLOW row */
const excused = (r: ExportResource, destroyed: DestroyedEntry[]): boolean => destroyed.some((d) => d.id === r.id && d.ts >= r.created_at_ms);

function missingFindings(live: LiveResource[], c: Ctx, at: number): Finding[] {
  const liveIds = new Set(live.map((l) => l.id));
  const out: Finding[] = [];
  for (const r of c.rows.values()) {
    if (!COVERAGE.includes(r.class) || r.destroyed_at_ms !== null || liveIds.has(r.id) || excused(r, c.destroyed)) continue;
    if (at - r.created_at_ms < INFLIGHT_GRACE_MS) continue; // AG4-PRD-7: created after (or while) this poll started: in flight, not missing
    out.push(finding('RECONCILE_RED_MISSING', r, `${r.label} has an ALLOW row but is not in Vultr`));
  }
  return out;
}

function findingsOf(poll: Extract<Snapshot, { ok: true }>, c: Ctx): Finding[] {
  const out: Finding[] = [];
  const base = new Map(c.baseline.map((b) => [b.id, b]));
  for (const l of poll.live) {
    const b = base.get(l.id);
    const diff = b ? baselineDiff(b, l) : null;
    if (b && diff) out.push(finding('RECONCILE_RED_PROTECTED_CHANGED', l, `baseline resource changed: ${diff}`));
    if (!b) out.push(...ledgerFindings(l, c, poll.at));
  }
  const liveIds = new Set(poll.live.map((l) => l.id));
  for (const b of c.baseline) if (!liveIds.has(b.id)) out.push(finding('RECONCILE_RED_PROTECTED_CHANGED', b, `baseline resource ${b.label} is gone from Vultr`));
  return [...out, ...missingFindings(poll.live, c, poll.at)];
}

const hold = (a: Finding[], b: Finding[]): Finding[] => {
  const second = new Set(b.map((f) => `${f.code}:${f.resource_id}`));
  return a.filter((f) => second.has(`${f.code}:${f.resource_id}`));
};

function baselineProblem(b: BaselineEntry[] | null): string | null {
  if (b === null) return 'baseline manifest missing or unparseable';
  if (b.length === 0) return 'baseline manifest is empty';
  const bad = b.find((e) => e.class === 'instance' && (typeof e.power_status !== 'string' || typeof e.os !== 'string' || e.power_status === '' || e.os === ''));
  return bad ? `baseline entry ${bad.label} lacks power_status/os, so a stopped or reimaged protected VM would go unseen` : null;
}

function prodDbOf(poll: Snapshot, host: string): ProdDbRead {
  const l = poll.ok ? poll.live.find((x) => x.label === PROD_DB_LABEL) : undefined;
  return {
    found: l !== undefined, id: l?.id ?? null, label: PROD_DB_LABEL, status: l?.status ?? null, power_status: l?.power_status ?? null,
    plan: l?.plan ?? null, region: l?.region ?? null, os: l?.os ?? null, read_at: poll.at, read_by: host,
  };
}

function shell(i: ReconcileInput): Omit<Report, 'status' | 'codes' | 'findings' | 'counts' | 'ledger'> {
  const host = i.host ?? 'unknown';
  return {
    coverage: COVERAGE, not_covered: NOT_COVERED, limits: LIMITS, generated_at: i.now, polls: [i.poll1.at, i.poll2.at], polled_twice: true,
    prod_db: prodDbOf(i.poll2, host), notes: [...(i.notes ?? [])], verifier_host: host,
  };
}

const zero = (i: ReconcileInput) => ({
  live: 0, baseline: i.baseline?.length ?? 0, ledger_rows: i.ledger?.resources.length ?? 0, decisions: i.ledger?.decisions.length ?? 0,
  allow: 0, deny: 0, escalate: 0, unauthorized: 0, unknown_outcomes: i.ledger?.unknown_outcomes.length ?? 0,
});

function ledgerInfo(i: ReconcileInput, pin: Pin | null): Report['ledger'] {
  return { trust: i.ledgerTrust, head: i.ledger?.chain_head ?? null, generated_at: i.ledger?.generated_at ?? null, pin };
}

function early(i: ReconcileInput, code: Code, why: string): Report {
  const red = code !== 'RECONCILE_DEGRADED';
  return {
    ...shell(i), status: red ? 'RED' : 'DEGRADED', codes: [code], findings: [{ code, resource_id: '', class: '', detail: why }],
    counts: zero(i), ledger: ledgerInfo(i, null),
  };
}

/** poll or input problems that make the comparison itself unsafe: DEGRADED */
function degradedReason(i: ReconcileInput): string | null {
  if (!i.poll1.ok) return `first poll failed: ${i.poll1.error}`;
  if (!i.poll2.ok) return `second poll failed: ${i.poll2.error}`;
  if (!i.ledger) return `ledger export unavailable: ${i.ledgerError ?? 'unknown'}`;
  const b = baselineProblem(i.baseline);
  if (b) return b;
  if (!i.floor) return 'production floor unavailable: the policy engine cannot be re-run on live state';
  return null;
}

/** AG4-VER-1: chain, freshness, ALLOW tie, optional pinned head, and append-only continuity with the last verified export */
function exportProblem(i: ReconcileInput, ledger: LedgerExport): { code: Code; why: string } | null {
  const v = verifyExport(ledger, { now_ms: i.now, max_age_ms: i.maxExportAgeMs ?? 60_000, expect_head: i.expectHead });
  if (!v.ok) return { code: v.reason === 'STALE' ? 'RECONCILE_DEGRADED' : 'RECONCILE_RED_LEDGER_TAMPERED', why: `ledger export refused: ${v.reason}${v.detail ? ` (${v.detail})` : ''}` };
  const p = i.continuity;
  if (p && ledger.decisions[p.seq - 1]?.row_hash !== p.row_hash) return { code: 'RECONCILE_RED_LEDGER_TAMPERED', why: `history rewritten: decision #${p.seq} verified earlier is not in this export` };
  const poll2 = i.poll2.at;
  if (!i.exportMayPrecedePolls && ledger.generated_at < poll2 - INFLIGHT_GRACE_MS) return { code: 'RECONCILE_DEGRADED', why: 'ledger export predates the live poll (AG4-PRD-7: the export must be taken after the list)' };
  return null;
}

function counts(i: ReconcileInput, ledger: LedgerExport, live: number, unauthorized: number): Report['counts'] {
  const n = (d: string): number => ledger.decisions.filter((x) => x.decision === d && x.session_id !== 'system').length;
  return { ...zero(i), live, allow: n('ALLOW'), deny: n('DENY'), escalate: n('ESCALATE'), unauthorized };
}

function downgrade(i: ReconcileInput): string | null {
  if (i.baselineMode === 'derived') return 'weak mode: the baseline was guessed from live labels, so an owner-declared look-alike would pass; pass --baseline for the strong verdict';
  if (i.ledgerTrust === 'unverified') return 'the ledger is unverified (no pinned head or authenticated fetch), so a forged ledger would pass; pass --expect-head';
  return null;
}

export function reconcile(i: ReconcileInput): Report {
  const why = degradedReason(i);
  if (why || !i.poll1.ok || !i.poll2.ok || !i.ledger || !i.baseline || !i.floor) return early(i, 'RECONCILE_DEGRADED', why ?? 'incomplete input');
  const bad = exportProblem(i, i.ledger);
  if (bad) return early(i, bad.code, bad.why);
  const ledger = i.ledger;
  const decisions = new Map(ledger.decisions.map((d) => [d.id, d.decision as string]));
  const c: Ctx = { baseline: i.baseline, rows: new Map(ledger.resources.map((r) => [r.id, r])), decisions, destroyed: i.watchdogDestroyed, floor: i.floor, now: i.now };
  const findings = hold(findingsOf(i.poll1, c), findingsOf(i.poll2, c));
  const unauthorized = findings.filter((f) => f.code === 'RECONCILE_RED_UNLOGGED').length;
  const last = ledger.decisions[ledger.decisions.length - 1];
  const out: Report = {
    ...shell(i), status: findings.length === 0 ? 'GREEN' : 'RED', codes: [...new Set(findings.map((f) => f.code))], findings,
    counts: counts(i, ledger, i.poll2.live.length, unauthorized), ledger: ledgerInfo(i, last ? { seq: last.seq, row_hash: last.row_hash } : null),
  };
  const weak = out.status === 'GREEN' ? downgrade(i) : null;
  if (!weak) return out;
  return { ...out, status: 'DEGRADED', codes: ['RECONCILE_DEGRADED'], findings: [{ code: 'RECONCILE_DEGRADED', resource_id: '', class: '', detail: weak }], notes: [...out.notes, weak] };
}
