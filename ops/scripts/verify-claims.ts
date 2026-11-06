// File: ops/scripts/verify-claims.ts
// Recomputes every claim from committed evidence and regenerates CLAIMS.md + evidence/claims-regenerated.json.
// Rules: a row is CITABLE only when recomputed evidence passes; anything missing, stale, foreign or tampered stays WITHHELD.
// The claim table lives in this file. CLAIMS.md and claims-regenerated.json are OUTPUTS and are never read back as input.
// Evidence is citable only if (AG4-OPS-5 / CO-2): digest intact, pass recomputed from checks, base origin == the judged PLUMBLINE_URL
// (never loopback), ran_at younger than the bound and later than the last commit touching the claim's code paths, git commit == HEAD
// or declared in evidence/declared-commits.json, and -run1..-runN files exist and pass for repetition claims.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '@plumbline/policy-engine';

export type Status = 'CITABLE' | 'WITHHELD';
export interface ClaimDef { id: string; claim: string; evidence: string; recompute: string; paths: string[]; runs?: number; needle?: string }
export interface Row { id: string; status: Status; reasons: string[]; tampered: boolean }

export const CLAIMS: ClaimDef[] = [
  { id: 'CL-L1', claim: 'Protected resources cannot be destroyed through the range; the live Vultr list is unchanged after the attack', evidence: 'evidence/gate-l1.json', recompute: 'npm run gate -- l1', paths: ['packages/policy-engine', 'apps/broker', 'packages/sandbox', 'apps/runner', 'packages/operator', 'apps/range-api'] },
  { id: 'CL-L2', claim: 'The verifier turns RED naming an out-of-band instance, then GREEN', evidence: 'evidence/gate-l2.json', recompute: 'npm run gate -- l2', paths: ['apps/verifier', 'packages/ledger'], runs: 2 },
  { id: 'CL-L3', claim: 'A dead broker lease makes VM 2 destroy workers and playgrounds only', evidence: 'evidence/gate-l3.json', recompute: 'npm run gate -- l3', paths: ['apps/verifier/src/watchdog.ts', 'apps/broker/src/lease.ts'] },
  { id: 'CL-L4', claim: 'A view-only tier key gets Vultr 403 on create', evidence: 'evidence/gate-l4.json', recompute: 'npm run gate -- l4', paths: ['packages/vultr-adapter/src/users.ts', 'packages/vultr-adapter/src/tiers.ts'] },
  { id: 'CL-L5', claim: 'Firewall group and VPC create/delete go through the engine and the live list confirms them gone; registry create is engine-gated (Vultr allows one free registry and the protected shared one holds it) and the shared registry cannot be deleted', evidence: 'evidence/gate-l5.json', recompute: 'npm run gate -- l5', paths: ['packages/vultr-adapter/src/resources.ts'] },
  { id: 'CL-L6', claim: 'A deleted canary object is restored as a new version from S3 truth', evidence: 'evidence/gate-l6.json', recompute: 'npm run gate -- l6', paths: ['packages/rewind', 'packages/vultr-adapter/src/s3.ts'] },
  { id: 'CL-L7', claim: 'After a bond slash the next provision is refused', evidence: 'evidence/gate-l7.json', recompute: 'npm run gate -- l7', paths: ['packages/ledger/src/bond.ts'] },
  { id: 'CL-GV', claim: 'gVisor isolation (claim only if U-1 printed GVISOR OK)', evidence: 'evidence/probe-first-hour.txt', recompute: "grep 'GVISOR OK'", paths: [], needle: 'GVISOR OK' },
];

const OWN_OUTPUTS = new Set(['CLAIMS.md', 'claims-regenerated.json']);
const MARKER = 'verify-claims';
const FUTURE_SKEW_MS = 5 * 60_000;

export interface Ctx {
  base: string | null;
  head: string;
  now: number;
  maxAgeMs: number;
  readText(rel: string): string | null;
  /** ISO commit date of the newest commit touching any path, or null when git cannot say. */
  lastTouchIso(paths: string[]): string | null;
  declared: Set<string>;
}

export const evidenceDigest = (doc: Record<string, unknown>): string => {
  const { evidence_sha256: _omit, ...rest } = doc;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
};

const isLoopback = (host: string): boolean => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/.test(host) || /\.(localhost|test|invalid)$/.test(host);

/** Origin of the judged deployment, or an error string. Loopback and non-http(s) are never a deployment. */
export function judgedOrigin(url: string | null | undefined): { origin: string } | { error: string } {
  if (!url) return { error: 'PLUMBLINE_URL is not set: no judged deployment, nothing is citable' };
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { error: `judged URL ${url} is not http(s)` };
    if (isLoopback(u.hostname)) return { error: `judged URL ${u.origin} is loopback, not the deployed range` };
    return { origin: u.origin };
  } catch { return { error: `judged URL ${url} is not a URL` }; }
}

function parseDoc(rel: string, ctx: Ctx): { doc: Record<string, any> } | { error: string; tampered: boolean } {
  if (OWN_OUTPUTS.has(rel.split('/').pop() ?? '')) return { error: `refusing to read ${rel}: it is verify-claims' own output`, tampered: true };
  const text = ctx.readText(rel);
  if (text === null) return { error: `missing evidence ${rel}`, tampered: false };
  try {
    const doc = JSON.parse(text) as Record<string, any>;
    if (doc.generated_by === MARKER) return { error: `${rel} is verify-claims output, not evidence`, tampered: true };
    return { doc };
  } catch { return { error: `${rel} is not valid JSON`, tampered: true }; }
}

function integrityErrors(doc: Record<string, any>, gate: string): string[] {
  const errs: string[] = [];
  const checks = doc.checks;
  if (doc.gate !== gate) errs.push(`gate field ${String(doc.gate)} != ${gate}`);
  if (!checks || typeof checks !== 'object' || Object.keys(checks).length === 0) errs.push('no checks recorded');
  else if (!Object.values(checks).every((v) => v === true)) errs.push('a recorded check is not true');
  if (doc.pass !== true) errs.push('pass is not true');
  if (typeof doc.evidence_sha256 !== 'string' || doc.evidence_sha256 !== evidenceDigest(doc)) errs.push('digest mismatch: evidence was edited after the run');
  return errs;
}

function provenanceErrors(doc: Record<string, any>, def: ClaimDef, ctx: Ctx, origin: string): string[] {
  const errs: string[] = [];
  let baseOrigin = '';
  try { baseOrigin = new URL(String(doc.base)).origin; } catch { /* reported below */ }
  if (baseOrigin !== origin) errs.push(`base ${String(doc.base)} is not the judged deployment ${origin}`);
  const ran = Date.parse(String(doc.ran_at));
  if (!Number.isFinite(ran)) return [...errs, 'ran_at is not a timestamp'];
  if (ran > ctx.now + FUTURE_SKEW_MS) errs.push('ran_at is in the future');
  if (ctx.now - ran > ctx.maxAgeMs) errs.push(`evidence older than the ${Math.round(ctx.maxAgeMs / 3600000)} h bound`);
  const touched = def.paths.length > 0 ? ctx.lastTouchIso(def.paths) : null;
  if (touched && ran < Date.parse(touched)) errs.push(`evidence predates the last commit touching its code (${touched})`);
  const declared = ctx.declared.has(String(doc.git_commit));
  if (doc.git_commit !== ctx.head && !declared) errs.push(`run commit ${String(doc.git_commit)} != HEAD ${ctx.head} and not declared`);
  if (doc.git_dirty === true && !declared) errs.push('run tree was dirty and the commit is not declared');
  return errs;
}

function evaluateGate(def: ClaimDef, ctx: Ctx, origin: string): Row {
  const gate = def.evidence.replace(/^evidence\//, '').replace(/\.json$/, '');
  const files = [def.evidence, ...Array.from({ length: def.runs ?? 0 }, (_, i) => `evidence/${gate}-run${i + 1}.json`)];
  const reasons: string[] = [];
  let tampered = false;
  for (const rel of files) {
    const parsed = parseDoc(rel, ctx);
    if ('error' in parsed) { reasons.push(parsed.error); tampered ||= parsed.tampered; continue; }
    const errs = [...integrityErrors(parsed.doc, gate), ...provenanceErrors(parsed.doc, def, ctx, origin)];
    if (errs.length > 0 && errs.some((e) => e.startsWith('digest') || e.startsWith('gate field'))) tampered = true;
    reasons.push(...errs.map((e) => `${rel}: ${e}`));
  }
  return { id: def.id, status: reasons.length === 0 ? 'CITABLE' : 'WITHHELD', reasons, tampered };
}

function evaluateProbe(def: ClaimDef, ctx: Ctx): Row {
  if (OWN_OUTPUTS.has(def.evidence.split('/').pop() ?? '')) return { id: def.id, status: 'WITHHELD', reasons: ['evidence is verify-claims own output'], tampered: true };
  const text = ctx.readText(def.evidence);
  if (text === null) return { id: def.id, status: 'WITHHELD', reasons: [`missing evidence ${def.evidence}`], tampered: false };
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const ok = def.needle !== undefined && last.endsWith(def.needle);
  return { id: def.id, status: ok ? 'CITABLE' : 'WITHHELD', reasons: ok ? [] : [`last line of ${def.evidence} is not '${def.needle}' (U-1 not passed)`], tampered: false };
}

export function evaluateClaim(def: ClaimDef, ctx: Ctx): Row {
  if (def.needle !== undefined) return evaluateProbe(def, ctx);
  const origin = judgedOrigin(ctx.base);
  if ('error' in origin) return { id: def.id, status: 'WITHHELD', reasons: [origin.error], tampered: false };
  return evaluateGate(def, ctx, origin.origin);
}

export function evaluateAll(ctx: Ctx, defs: ClaimDef[] = CLAIMS): Row[] {
  return defs.map((d) => evaluateClaim(d, ctx));
}

export function renderClaimsMd(rows: Row[], defs: ClaimDef[] = CLAIMS): string {
  const head = ['# Claims ledger', 'Generated by `npm run verify-claims` from recomputed evidence (it never reads this file back). Do not edit by hand. A row is CITABLE only when its evidence file passes every recompute check; otherwise it stays WITHHELD.', '',
    '| id | claim | evidence file | recompute command | code paths | status | note |', '|---|---|---|---|---|---|---|'];
  const body = defs.map((d) => {
    const r = rows.find((x) => x.id === d.id) as Row;
    const note = r.reasons[0] ? r.reasons[0].replaceAll('|', '/').slice(0, 140) : '';
    return `| ${d.id} | ${d.claim} | ${d.evidence} | ${d.recompute.replaceAll('|', '/')} | ${d.paths.join(', ') || 'n/a'} | ${r.status} | ${note} |`;
  });
  return [...head, ...body, ''].join('\n');
}

export function buildReport(rows: Row[], ctx: Ctx, proof: unknown): Record<string, unknown> {
  return {
    generated_by: MARKER, regenerated_at: new Date(ctx.now).toISOString(), judged_url: ctx.base, head: ctx.head,
    citable: rows.filter((r) => r.status === 'CITABLE').map((r) => r.id),
    withheld: rows.filter((r) => r.status === 'WITHHELD').map((r) => r.id),
    reasons: Object.fromEntries(rows.filter((r) => r.reasons.length > 0).map((r) => [r.id, r.reasons])),
    tampered: rows.filter((r) => r.tampered).map((r) => r.id),
    proof,
  };
}

// ---- live wiring ----
function liveCtx(app: string, env: NodeJS.ProcessEnv): Ctx {
  const git = (...a: string[]): string => execFileSync('git', ['-C', app, ...a], { encoding: 'utf8' }).trim();
  const readText = (rel: string): string | null => (existsSync(`${app}${rel}`) ? readFileSync(`${app}${rel}`, 'utf8') : null);
  const declared = new Set<string>();
  try { for (const d of JSON.parse(readText('evidence/declared-commits.json') ?? '[]') as { commit?: string; reason?: string }[]) if (d.commit && d.reason?.trim()) declared.add(d.commit); } catch { /* none declared */ }
  return {
    base: env.PLUMBLINE_URL ?? null, now: Date.now(), maxAgeMs: Number(env.PLUMBLINE_EVIDENCE_MAX_AGE_H ?? 48) * 3600_000, declared, readText,
    head: (() => { try { return git('rev-parse', 'HEAD'); } catch { return 'unknown'; } })(),
    lastTouchIso: (paths) => { try { return git('log', '-1', '--format=%cI', '--', ...paths) || null; } catch { return null; } },
  };
}

async function fetchProof(base: string | null): Promise<unknown> {
  if (!base || 'error' in judgedOrigin(base)) return null;
  try {
    const p = (await (await fetch(`${base}/api/proof`, { signal: AbortSignal.timeout(10_000) })).json()) as { counts?: unknown; floor?: { hash?: string } };
    return { counts: p.counts ?? null, floor_hash: p.floor?.hash ?? null, fetched_at: new Date().toISOString() };
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = new URL('../../', import.meta.url).pathname;
  const ctx = liveCtx(app, process.env);
  const rows = evaluateAll(ctx);
  const report = buildReport(rows, ctx, await fetchProof(ctx.base));
  writeFileSync(`${app}evidence/claims-regenerated.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${app}CLAIMS.md`, renderClaimsMd(rows));
  console.log(JSON.stringify({ citable: report.citable, withheld: report.withheld, tampered: report.tampered }));
  process.exit(rows.some((r) => r.tampered) ? 1 : 0);
}
