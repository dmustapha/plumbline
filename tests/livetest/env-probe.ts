// File: tests/livetest/env-probe.ts  (single re-run of V2-F4-ENV, paced; merges into api-results.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { liveEnv } from '../../ops/scripts/gates.ts';
const e = liveEnv(process.env.PLUMBLINE_URL ?? 'https://plumbline.108-61-70-169.sslip.io');
let sid = ''; for (let i = 0; i < 14 && !sid; i++) { const r = await e.http('/api/session', 'POST', {}); sid = String(r.json.session_id ?? ''); if (!sid) await e.sleep(60_000); }
const r = await e.http('/api/env-proof', 'POST', { session_id: sid }); const out = JSON.stringify(r.json);
const count = Number(/ENV COUNT:\s*(\d+)/.exec(out)?.[1] ?? NaN);
const pass = r.status === 200 && count <= 12 && !/VULTR_|PLUMBLINE_|API_?KEY|TOKEN|SECRET|PASSWORD/i.test(out);
console.log(pass ? 'PASS' : 'FAIL', `status=${r.status} count=${count}`, out.slice(0, 300));
const p = 'evidence/livetest/api-results.json'; const d = JSON.parse(readFileSync(p, 'utf8'));
d.rows = d.rows.map((x: any) => (x.id === 'V2-F4-ENV' ? { ...x, actual: `count=${count} status=${r.status}`, status: pass ? 'PASS' : 'FAIL', note: 'first run got 429 (probe shares the 3 per minute attack limit, my pacing); re-run alone by tests/livetest/env-probe.ts' } : x));
d.summary = { PASS: d.rows.filter((x: any) => x.status === 'PASS').length, FAIL: d.rows.filter((x: any) => x.status === 'FAIL').length, SKIP: d.rows.filter((x: any) => x.status === 'SKIP').length };
writeFileSync(p, JSON.stringify(d, null, 1)); console.log(JSON.stringify(d.summary));
