// File: tests/livetest/ui.mjs
// Livetest web domains: console errors, visual completeness, mobile, forms, and the UI leg of the multi-channel matrix.
// Run: PLAYWRIGHT=/opt/homebrew/lib/node_modules/playwright/index.mjs PLUMBLINE_URL=https://... node tests/livetest/ui.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.PLUMBLINE_URL ?? 'https://plumbline.108-61-70-169.sslip.io';
const PAGES = ['/', '/try', '/controls/policy', '/controls/limits', '/controls/recovery', '/audit/ledger', '/audit/reconcile', '/audit/evidence', '/docs/check', '/docs/safety', '/docs/architecture', '/docs/concepts', '/docs/integrate', '/deploy'];
mkdirSync('evidence/livetest', { recursive: true });
const out = { base: BASE, ran_at: new Date().toISOString(), domains: {} };
const b = await chromium.launch();
const isFirstParty = (u) => !u || u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:');

// D5 console + D3 visual: every page, desktop
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const consoleErr = []; const visual = [];
for (const p of PAGES) {
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => consoleErr.push({ page: p, err: String(e.message).slice(0, 140) }));
  pg.on('console', (m) => { if (m.type() === 'error' && isFirstParty(m.location().url)) consoleErr.push({ page: p, err: m.text().slice(0, 140) }); });
  await pg.goto(BASE + p, { waitUntil: 'load' }); await pg.waitForTimeout(4500);
  const txt = await pg.locator('body').innerText();
  const bad = [...txt.matchAll(/\b(undefined|NaN|\[object Object\]|null)\b/g)].map((m) => m[0]);
  const broken = await pg.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(-40)));
  const todo = /lorem ipsum|\bTODO\b/i.test(txt);
  visual.push({ page: p, badTokens: bad, brokenImages: broken, todo });
  await pg.close();
}
out.domains.console_errors = { status: consoleErr.length ? 'FAIL' : 'PASS', errors: consoleErr };
out.domains.visual = { status: visual.some((v) => v.badTokens.length || v.brokenImages.length || v.todo) ? 'FAIL' : 'PASS', pages: visual };

// D7 mobile 375
const mctx = await b.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }); const mob = [];
for (const p of PAGES) {
  const pg = await mctx.newPage(); await pg.goto(BASE + p, { waitUntil: 'load' }); await pg.waitForTimeout(3500);
  const m = await pg.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, small: [...document.querySelectorAll('a,button,select,input,textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24) && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.sr-only,a.skip'); }).length, minFont: Math.min(...[...document.querySelectorAll('p,li,td,span,a,button')].filter((e) => e.offsetParent && e.textContent.trim().length > 3).map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((n) => n > 0)) }));
  mob.push({ page: p, ...m }); await pg.close();
}
out.domains.mobile = { status: mob.some((m) => m.overflow) ? 'FAIL' : mob.some((m) => m.minFont < 11) ? 'WARN' : 'PASS', pages: mob };

// D4 forms + D1 UI leg of the matrix (one real attack through the UI), same context so one session
const pg = await ctx.newPage(); const errs2 = []; pg.on('pageerror', (e) => errs2.push(String(e.message)));
await pg.goto(BASE + '/try', { waitUntil: 'load' }); await pg.waitForTimeout(8000);
const box = pg.locator('textarea').first(); await box.fill(''); await pg.locator('#fire').click(); await pg.waitForTimeout(1500);
const emptyState = { disabled: await pg.locator('#fire').isDisabled(), text: (await pg.locator('body').innerText()).slice(0, 3000) };
out.domains.forms = { status: errs2.length === 0 && emptyState.disabled === false ? 'PASS' : 'FAIL', emptySubmit: { fireStillUsable: emptyState.disabled === false, pageErrors: errs2 } };
await pg.locator('button', { hasText: /Delete prod-db/ }).first().click();
let big = ''; for (let i = 0; i < 30; i++) { await pg.waitForTimeout(2000); big = await pg.locator('#verdictbig').innerText().catch(() => ''); if (/DENY|ALLOW|ESCALATE/.test(big)) break; }
const feed = await pg.evaluate(() => document.body.textContent); const idm = /id (d-[0-9a-z]+-[0-9a-f]{8})/i.exec(feed)?.[1];
await pg.waitForTimeout(2000);
const replay = await (await fetch(BASE + '/api/replay')).json();
out.domains.core_flows = { status: /DENY/.test(big) && /protect-tagged-destroy/.test(big) ? 'PASS' : 'FAIL', verdictPanel: big.split('\n').slice(0, 4).join(' | ').slice(0, 200), uiDecisionId: idm ?? null, idInLedger: idm ? replay.some((r) => String(r.id) === idm) : false };
await pg.close(); await b.close();
writeFileSync('evidence/livetest/ui-results.json', JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out.domains)) console.log(k, v.status);
