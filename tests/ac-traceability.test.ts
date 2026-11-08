// Keeps docs/AC-TRACEABILITY.md honest: every PRD 4.19 acceptance id has a row, and every artifact a row names still exists.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const doc = readFileSync(`${root}docs/AC-TRACEABILITY.md`, 'utf8');

const AC_IDS = [
  'AC-ALL-1', 'AC-ALL-2', 'AC-L1-1', 'AC-L1-2', 'AC-L1-3', 'AC-L1-4', 'AC-L1-5',
  'AC-L2-1', 'AC-L2-2', 'AC-L2-3', 'AC-L2-4', 'AC-L3-1', 'AC-L4-1', 'AC-L5-1', 'AC-L6-1', 'AC-L7-1',
];
const STATUSES = ['COVERED by test', 'COVERED by live gate', 'GAP'];

interface Row { id: string; status: string; tests: { file: string; title: string }[]; gates: { file: string; key: string }[] }

function parseRows(): Row[] {
  return doc.split('\n').filter((l) => /^\|\s*AC-/.test(l)).map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    const [, id = '', , status = '', testCell = '', gateCell = ''] = cells;
    const tests = [...testCell.matchAll(/`([^`]+?) :: ([^`]+?)`/g)].map((m) => ({ file: m[1] as string, title: m[2] as string }));
    const gates = [...gateCell.matchAll(/`(gate-l\d[\w-]*\.json)#(\w+)`/g)].map((m) => ({ file: m[1] as string, key: m[2] as string }));
    return { id, status, tests, gates };
  });
}

const rows = parseRows();

describe('AC traceability (PRD 4.19)', () => {
  it('has exactly one row for each of the 16 acceptance ids', () => {
    expect(rows.map((r) => r.id).sort()).toEqual([...AC_IDS].sort());
  });

  it('the id list matches the PRD table when the PRD is present', () => {
    const prd = `${root}../PRD.md`;
    if (!existsSync(prd)) return;
    const section = readFileSync(prd, 'utf8').split('### 4.19')[1]?.split('\n---')[0] ?? '';
    const ids = [...new Set([...section.matchAll(/^\| (AC-[A-Z0-9]+-\d+) \|/gm)].map((m) => m[1] as string))];
    expect(ids.sort()).toEqual([...AC_IDS].sort());
  });

  it('every row has a known status and every non-GAP row names an artifact', () => {
    for (const r of rows) {
      expect(STATUSES, `${r.id} status "${r.status}"`).toContain(r.status);
      if (r.status !== 'GAP') expect(r.tests.length + r.gates.length, `${r.id} has no artifact`).toBeGreaterThan(0);
      if (r.status === 'COVERED by test') expect(r.tests.length, `${r.id} claims test coverage`).toBeGreaterThan(0);
      if (r.status === 'COVERED by live gate') expect(r.gates.length, `${r.id} claims gate coverage`).toBeGreaterThan(0);
    }
  });

  it('every GAP row is listed in the Gaps section', () => {
    const gaps = doc.split('## Gaps')[1] ?? '';
    for (const r of rows.filter((x) => x.status === 'GAP')) expect(gaps, `${r.id} missing from Gaps`).toContain(r.id);
  });

  it('every referenced test file exists and contains each quoted title', () => {
    for (const r of rows) {
      for (const t of r.tests) {
        const path = `${root}${t.file}`;
        expect(existsSync(path), `${r.id}: missing test file ${t.file}`).toBe(true);
        expect(readFileSync(path, 'utf8'), `${r.id}: title not found in ${t.file}: ${t.title}`).toContain(t.title);
      }
    }
  });

  it('every referenced gate evidence key exists under checks', () => {
    for (const r of rows) {
      for (const g of r.gates) {
        const path = `${root}evidence/${g.file}`;
        expect(existsSync(path), `${r.id}: missing evidence ${g.file}`).toBe(true);
        const checks = (JSON.parse(readFileSync(path, 'utf8')) as { checks?: Record<string, unknown> }).checks ?? {};
        expect(Object.keys(checks), `${r.id}: ${g.file} has no checks.${g.key}`).toContain(g.key);
      }
    }
  });
});
