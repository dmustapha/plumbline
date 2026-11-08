// File: tests/livetest/cold.mjs
// Cold-stranger hero gate: a fresh browser context with NO storage and NO environment (run under `env -i`) completes the hero on the public URL.
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
import { writeFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.URL; if (!BASE) throw new Error('URL required');
const leaked = Object.keys(process.env).filter((k) => /VULTR|PLUMBLINE|API_?KEY|TOKEN|SECRET/i.test(k));
const t0 = Date.now(); const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
await p.goto(BASE + '/'); await p.waitForTimeout(2500);
await p.getByText(/Attack prod-db/i).first().click();
let big = ''; for (let i = 0; i < 40; i++) { await p.waitForTimeout(2000); big = await p.locator('#verdictbig').innerText().catch(() => ''); if (/DENY|ALLOW|ESCALATE/.test(big)) break; }
await p.waitForTimeout(1500);
const body = await p.locator('body').innerText();
const res = { base: BASE, envLeaked: leaked, isolation: 'env -i PATH HOME URL only; fresh browser context, no storageState', durationSeconds: Math.round((Date.now() - t0) / 100) / 10,
  verdictSeen: big.split('\n').slice(0, 3).join(' | ').slice(0, 200), denied: /DENY/.test(big) && /protect-tagged-destroy/.test(big), prodDbUnchanged: /prod-?db/i.test(body) && /UNCHANGED|active/i.test(body), landedOn: p.url() };
mkdirSync('evidence/livetest', { recursive: true }); writeFileSync('evidence/livetest/cold-stranger.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res)); await b.close();
