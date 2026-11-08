import { describe, expect, it } from 'vitest';
import { buildEvidence } from '../ops/scripts/gates.ts';
import { CLAIMS, buildReport, evaluateAll, evaluateClaim, evidenceDigest, judgedOrigin, renderClaimsMd, type ClaimDef, type Ctx } from '../ops/scripts/verify-claims.ts';

const URL_ = 'https://1-2-3-4.sslip.io';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const HEAD = 'head123';
const RAN = '2026-11-07T10:00:00.000Z';

const doc = (gate: string, over: Record<string, unknown> = {}, checks: Record<string, boolean> = { ok: true }) =>
  buildEvidence(gate, checks, {}, { base: URL_, ran_at: RAN, git_commit: HEAD, git_dirty: false, ...over } as never);

function ctxWith(files: Record<string, string>, over: Partial<Ctx> = {}): Ctx & { reads: string[] } {
  const reads: string[] = [];
  return { reads, base: URL_, head: HEAD, now: NOW, maxAgeMs: 48 * 3600_000, declared: new Set(), lastTouchIso: () => '2026-11-07T08:00:00Z',
    readText: (rel) => { reads.push(rel); return files[rel] ?? null; }, ...over };
}
const put = (files: Record<string, string>, name: string, d: unknown) => { files[`evidence/${name}.json`] = JSON.stringify(d); };
const L1 = CLAIMS.find((c) => c.id === 'CL-L1') as ClaimDef;
const L2 = CLAIMS.find((c) => c.id === 'CL-L2') as ClaimDef;
const GV = CLAIMS.find((c) => c.id === 'CL-GV') as ClaimDef;

describe('verify-claims: citable only from recomputed evidence', () => {
  it('flips a row to CITABLE when the evidence is intact, fresh, from the judged host and at HEAD', () => {
    const files: Record<string, string> = {}; put(files, 'gate-l1', doc('gate-l1'));
    expect(evaluateClaim(L1, ctxWith(files))).toMatchObject({ status: 'CITABLE', reasons: [] });
  });
  it('keeps EVERY row WITHHELD when evidence is missing', () => {
    const rows = evaluateAll(ctxWith({}));
    expect(rows.every((r) => r.status === 'WITHHELD')).toBe(true);
    expect(rows.find((r) => r.id === 'CL-L1')?.reasons[0]).toContain('missing evidence');
    expect(buildReport(rows, ctxWith({}), null).citable).toEqual([]);
  });
  it('rejects tampered evidence: a flipped check, a forged pass, an edited time', () => {
    const base = doc('gate-l1', {}, { a: true, b: false });
    const cases: Record<string, unknown>[] = [
      { ...base, pass: true },
      { ...doc('gate-l1'), checks: { ok: false } },
      { ...doc('gate-l1'), ran_at: '2026-11-07T11:59:00.000Z' },
      (() => { const { evidence_sha256: _x, ...rest } = doc('gate-l1'); return rest; })(),
      { ...doc('gate-l1'), gate: 'gate-l4' },
    ];
    for (const c of cases) {
      const files: Record<string, string> = {}; put(files, 'gate-l1', c);
      const r = evaluateClaim(L1, ctxWith(files));
      expect(r.status, JSON.stringify(c).slice(0, 80)).toBe('WITHHELD');
    }
    const files: Record<string, string> = {}; put(files, 'gate-l1', { ...doc('gate-l1'), checks: { ok: false } });
    expect(evaluateClaim(L1, ctxWith(files)).tampered).toBe(true);
  });
  it('rejects unparseable evidence', () => {
    const r = evaluateClaim(L1, ctxWith({ 'evidence/gate-l1.json': '{not json' }));
    expect(r).toMatchObject({ status: 'WITHHELD', tampered: true });
  });
});

describe('AG4-OPS-5 evidence provenance', () => {
  const one = (d: unknown, over: Partial<Ctx> = {}) => { const files: Record<string, string> = {}; put(files, 'gate-l1', d); return evaluateClaim(L1, ctxWith(files, over)); };
  it('AG4-OPS-5 evidence from 127.0.0.1 or another host is not citable', () => {
    expect(one(doc('gate-l1', { base: 'http://127.0.0.1:8080' })).reasons.join()).toContain('not the judged deployment');
    expect(one(doc('gate-l1', { base: 'https://9-9-9-9.sslip.io' })).status).toBe('WITHHELD');
  });
  it('AG4-OPS-5 a loopback or missing PLUMBLINE_URL makes nothing citable', () => {
    expect(judgedOrigin('http://localhost:8080')).toHaveProperty('error');
    expect(judgedOrigin('http://127.0.0.1:8080')).toHaveProperty('error');
    expect(judgedOrigin('http://[::1]:8080')).toHaveProperty('error');
    expect(judgedOrigin(undefined)).toHaveProperty('error');
    expect(judgedOrigin(URL_)).toEqual({ origin: URL_ });
    const files: Record<string, string> = {}; put(files, 'gate-l1', doc('gate-l1', { base: 'http://127.0.0.1:8080' }));
    expect(evaluateClaim(L1, ctxWith(files, { base: 'http://127.0.0.1:8080' })).status).toBe('WITHHELD');
  });
  it('AG4-OPS-5 evidence older than the bound, or from the future, is not citable', () => {
    expect(one(doc('gate-l1', { ran_at: '2026-11-04T10:00:00.000Z' })).reasons.join()).toContain('older than');
    expect(one(doc('gate-l1', { ran_at: '2026-11-08T10:00:00.000Z' })).reasons.join()).toContain('future');
  });
  it('AG4-OPS-5 a run at another commit is not citable unless the commit is declared', () => {
    const d = doc('gate-l1', { git_commit: 'old999' });
    expect(one(d).reasons.join()).toContain('not declared');
    expect(one(d, { declared: new Set(['old999']) }).status).toBe('CITABLE');
    expect(one(doc('gate-l1', { git_dirty: true })).reasons.join()).toContain('dirty');
  });
  it('CO-2 evidence older than the last commit touching the claim code paths is stale', () => {
    const seen: string[][] = [];
    const r = one(doc('gate-l1'), { lastTouchIso: (p) => { seen.push(p); return '2026-11-07T11:00:00Z'; } });
    expect(r.reasons.join()).toContain('predates the last commit');
    expect(seen[0]).toContain('apps/range-api');
  });
});

describe('repetition claims and the probe claim', () => {
  it('CL-L2 needs both -run1 and -run2 files, each passing', () => {
    const files: Record<string, string> = {}; put(files, 'gate-l2', doc('gate-l2')); put(files, 'gate-l2-run1', doc('gate-l2'));
    expect(evaluateClaim(L2, ctxWith(files)).reasons.join()).toContain('gate-l2-run2.json');
    put(files, 'gate-l2-run2', doc('gate-l2'));
    expect(evaluateClaim(L2, ctxWith(files)).status).toBe('CITABLE');
    put(files, 'gate-l2-run2', doc('gate-l2', {}, { ok: false }));
    expect(evaluateClaim(L2, ctxWith(files)).status).toBe('WITHHELD');
  });
  it('CL-GV is citable only when the final probe line is GVISOR OK', () => {
    expect(evaluateClaim(GV, ctxWith({ 'evidence/probe-first-hour.txt': 'U-3 x\nGVISOR OK\n' })).status).toBe('CITABLE');
    expect(evaluateClaim(GV, ctxWith({ 'evidence/probe-first-hour.txt': 'GVISOR OK\n2026 U-1 FAILED: stay\n' })).status).toBe('WITHHELD');
    expect(evaluateClaim(GV, ctxWith({})).status).toBe('WITHHELD');
  });
});

describe('refuses to read back its own output', () => {
  it('never reads CLAIMS.md or claims-regenerated.json, so a stale all-CITABLE CLAIMS.md changes nothing', () => {
    const ctx = ctxWith({ 'CLAIMS.md': CLAIMS.map((c) => `| ${c.id} | CITABLE |`).join('\n'), 'evidence/claims-regenerated.json': JSON.stringify({ citable: CLAIMS.map((c) => c.id) }) });
    const rows = evaluateAll(ctx);
    expect(rows.every((r) => r.status === 'WITHHELD')).toBe(true);
    expect(ctx.reads.some((r) => r.endsWith('CLAIMS.md') || r.endsWith('claims-regenerated.json'))).toBe(false);
  });
  it('an evidence entry pointing at an own-output file is rejected as tampering', () => {
    const own: ClaimDef = { ...L1, evidence: 'evidence/claims-regenerated.json' };
    expect(evaluateClaim(own, ctxWith({}))).toMatchObject({ status: 'WITHHELD', tampered: true });
  });
  it('a gate file that is really verify-claims output is rejected', () => {
    const files: Record<string, string> = {}; put(files, 'gate-l1', buildReport([], ctxWith({}), null));
    expect(evaluateClaim(L1, ctxWith(files))).toMatchObject({ status: 'WITHHELD', tampered: true });
  });
});

describe('outputs', () => {
  it('CLAIMS.md has the code paths column and mirrors the recomputed statuses', () => {
    const files: Record<string, string> = {}; put(files, 'gate-l1', doc('gate-l1'));
    const rows = evaluateAll(ctxWith(files));
    const md = renderClaimsMd(rows);
    expect(md).toContain('| code paths |');
    expect(md).toMatch(/\| CL-L1 \|.*\| CITABLE \|/);
    expect(md).toMatch(/\| CL-L4 \|.*\| WITHHELD \| missing evidence/);
  });
  it('the report lists citable and withheld ids and the digest helper ignores its own field', () => {
    const rows = evaluateAll(ctxWith({}));
    const rep = buildReport(rows, ctxWith({}), null);
    expect(rep.withheld).toHaveLength(CLAIMS.length);
    expect(rep.generated_by).toBe('verify-claims');
    const d = doc('gate-l1');
    expect(evidenceDigest(d)).toBe(evidenceDigest({ ...d, evidence_sha256: 'x' }));
  });
});

describe('declared host aliases', () => {
  const A = 'https://1-2-3-4.sslip.io'; const B = 'https://name.1-2-3-4.sslip.io';
  const hosts = (...h: string[]) => new Set(h);
  const evidence = () => { const f: Record<string, string> = {}; put(f, 'gate-l1', doc('gate-l1')); return f; };
  it('accepts evidence recorded at another name only when BOTH names are declared', () => {
    expect(evaluateClaim(L1, ctxWith(evidence(), { base: B, declaredHosts: hosts(A, B) }))).toMatchObject({ status: 'CITABLE' });
  });
  it('rejects the alias when only one of the two names is declared', () => {
    expect(evaluateClaim(L1, ctxWith(evidence(), { base: B, declaredHosts: hosts(B) })).status).toBe('WITHHELD');
    expect(evaluateClaim(L1, ctxWith(evidence(), { base: B, declaredHosts: hosts(A) })).status).toBe('WITHHELD');
  });
  it('rejects an undeclared foreign host even when other names are declared', () => {
    expect(evaluateClaim(L1, ctxWith(evidence(), { base: 'https://evil.example', declaredHosts: hosts(A, B) })).status).toBe('WITHHELD');
  });
});
