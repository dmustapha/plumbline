// File: ops/scripts/earn-history.ts
// The only way history rows exist: fires each model-path fixture through POST /api/attack and lets the real pipeline write the rows.
// It cannot write decision rows. Writes evidence/suite-latest.json (base URL, UTC time, run counts) and prints `N attacks, B breaches`.
// Usage: PLUMBLINE_URL=https://<dashed-ip>.sslip.io npm run earn-history
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadFixtures, runLiveSuite, type Fixture, type LiveOutcome } from '@plumbline/attacks';

export type Json = Record<string, any>;
export interface HistoryDeps {
  base: string;
  fetchJson(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const PER_SESSION = 3;
const POLL_MS = 2000;
const POLLS = 60;
const MAX_429_WAITS = 4;

/** POST with a bounded wait on 429 (session creation and attacks are rate limited; the limit applies to this script too). */
export async function postWithBackoff(d: HistoryDeps, path: string, body: unknown): Promise<{ status: number; json: any }> {
  for (let i = 0; ; i++) {
    const r = await d.fetchJson(path, { method: 'POST', body });
    if (r.status !== 429 || i >= MAX_429_WAITS) return r;
    await d.sleep(Math.min(Math.max(Number(r.json?.retry_after_s ?? 20), 1), 65) * 1000);
  }
}

export function makeAttacker(d: HistoryDeps): (f: Fixture) => Promise<LiveOutcome> {
  let sid = '';
  let used = 0;
  return async (f) => {
    if (!sid || used >= PER_SESSION) {
      sid = String((await postWithBackoff(d, '/api/session', {})).json.session_id ?? '');
      used = 0;
      if (!sid) return { rule_ids: [], decisions: [], refused: true };
    }
    used += 1;
    const since = d.now() - 1000;
    const fired = await postWithBackoff(d, '/api/attack', { session_id: sid, text: f.text });
    if (fired.status !== 202) return { rule_ids: [], decisions: [], refused: true };
    for (let i = 0; i < POLLS; i++) {
      await d.sleep(POLL_MS);
      const rows = (await d.fetchJson('/api/replay')).json as { ts: number; rule_id: string; decision: string; session_id: string }[];
      const mine = (Array.isArray(rows) ? rows : []).filter((r) => r.session_id === sid && r.ts >= since);
      if (mine.length > 0) return { rule_ids: mine.map((r) => r.rule_id), decisions: mine.map((r) => r.decision), refused: false };
    }
    return { rule_ids: [], decisions: [], refused: true };
  };
}

export async function earnHistory(d: HistoryDeps, fixtures: Fixture[]): Promise<Json> {
  const report = await runLiveSuite(fixtures, makeAttacker(d));
  return { ran_at: new Date(d.now()).toISOString(), base: d.base, ...report };
}

export const summaryLine = (r: Json): string => `${r.run} attacks, ${r.breaches} breaches (${r.matched} matched the expected rule, ${r.refused} refused or unobserved)`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.PLUMBLINE_URL ?? 'http://127.0.0.1:8080';
  const root = new URL('../../', import.meta.url).pathname;
  const deps: HistoryDeps = {
    base, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchJson: async (path, init) => {
      const res = await fetch(base + path, { method: init?.method ?? 'GET', headers: init?.body ? { 'content-type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
  };
  const fixtures = loadFixtures(`${root}attacks`).filter((f) => f.request && (!f.mode || f.mode === 'engine'));
  const report = await earnHistory(deps, fixtures);
  mkdirSync(`${root}evidence`, { recursive: true });
  writeFileSync(`${root}evidence/suite-latest.json`, JSON.stringify(report, null, 2));
  console.log(summaryLine(report));
  console.log(`evidence/suite-latest.json`);
  process.exit(report.breaches === 0 ? 0 : 1);
}
