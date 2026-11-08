// File: tests/stress/recovery.mjs
// Stress phases 6-8: hostile storage, injected 5xx / non-JSON / offline on the attack call, dropped SSE, double-click, refresh mid-attack, back button.
// Usage: PLAYWRIGHT=/opt/homebrew/lib/node_modules/playwright/index.mjs node tests/stress/recovery.mjs   (live attacks: 3 in total)
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
import { writeFileSync } from 'node:fs';
const BASE = process.env.PLUMBLINE_URL ?? 'https://plumbline.108-61-70-169.sslip.io';
const browser = await chromium.launch();
const res = [];
// one context for every scenario: the session cookie is shared, so the whole run holds ONE live session (the per-IP live cap is 4)
const ctx = await browser.newContext();
async function scenario(name, setup, act, check) {
  const page = await ctx.newPage(); const errs = []; const reqs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
  page.on('request', (r) => { if (r.url().includes('/api/attack')) reqs.push(r.method()); });
  try {
    if (setup) await setup(page, ctx);
    await page.goto(BASE + '/range', { waitUntil: 'load' }); await page.waitForTimeout(8000);
    const out = await act(page, reqs);
    const verdict = await check(page, out, reqs);
    res.push({ name, ok: verdict.ok && errs.length === 0, pageerrors: errs, note: verdict.note });
  } catch (e) { res.push({ name, ok: false, pageerrors: errs, note: 'THROW ' + String(e.message).slice(0, 160) }); }
  await page.close();
}
const fire = (p) => p.locator('button', { hasText: /^Fire$/ }).first();
const state = async (p) => ({ disabled: await fire(p).isDisabled().catch(() => null), text: (await p.locator('body').innerText()).slice(0, 4000) });
const hostile = (p) => p.addInitScript(() => { try { localStorage.setItem('plb-theme', '{{{not json'); localStorage.setItem('plb', '\u0000￿'); sessionStorage.setItem('plb_sess_reload', '1'); sessionStorage.setItem('plb_reloaded', 'x'.repeat(5000)); } catch (e) {} });

await scenario('R1 corrupted storage', hostile, async (p) => state(p), async (p, s) => ({ ok: s.disabled === false, note: 'fire enabled=' + (s.disabled === false) }));
for (const [tag, status, body, ct] of [['R2 503 html on /api/attack', 503, '<html>bad gateway</html>', 'text/html'], ['R3 200 non-JSON on /api/attack', 200, 'not json {{', 'application/json'], ['R3b 429 on /api/attack', 429, '{"status":"RATE_LIMITED"}', 'application/json']])
  await scenario(tag, (p) => p.route('**/api/attack', (r) => r.fulfill({ status, body, contentType: ct })), async (p) => { await fire(p).click(); await p.waitForTimeout(2500); return state(p); },
    async (p, s) => ({ ok: s.disabled === false, note: 'fire re-enabled=' + (s.disabled === false) + '; shows error=' + /refused|failed|unreachable|error|RATE|try again|wait|NOT FIRED|MALFORMED/i.test(s.text) }));
await scenario('R4 offline on /api/attack', (p) => p.route('**/api/attack', (r) => r.abort('internetdisconnected')), async (p) => { await fire(p).click(); await p.waitForTimeout(2500); return state(p); },
  async (p, s) => ({ ok: s.disabled === false, note: 'fire re-enabled=' + (s.disabled === false) + '; shows error=' + /unreachable|failed|offline|network|error/i.test(s.text) }));
await scenario('R5 garbage /api/live-list and /api/spend', (p) => p.route(/\/api\/(live-list|spend)/, (r) => r.fulfill({ status: 200, body: '<<<>>>', contentType: 'application/json' })), async (p) => state(p), async (p, s) => ({ ok: true, note: 'page rendered, body length ' + s.text.length }));
await scenario('R6 SSE dropped mid-attack, 120 s watchdog (live)', (p) => p.route('**/api/stream/**', (r) => r.abort('connectionreset')), async (p) => { await fire(p).click(); await p.waitForTimeout(135000); return state(p); },
  async (p, s) => ({ ok: s.disabled === false && /NO RESULT/i.test(s.text), note: 'after 135 s (watchdog is 120 s) fire enabled=' + (s.disabled === false) + '; says NO RESULT=' + /NO RESULT/i.test(s.text) }));
await scenario('R7 rapid double-click (live)', null, async (p, reqs) => { const b = fire(p); await b.dblclick(); await b.click({ force: true }).catch(() => {}); await p.waitForTimeout(3000); return reqs.length; },
  async (p, n) => ({ ok: n === 1, note: 'attack requests sent=' + n }));
await scenario('R8 refresh mid-attack then back (live)', null, async (p) => { await fire(p).click(); await p.waitForTimeout(2500); await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(4000); const a = await state(p); await p.goto(BASE + '/verify'); await p.goBack(); await p.waitForTimeout(3500); return { a, b: await state(p) }; },
  async (p, o) => ({ ok: o.a.text.length > 200 && o.b.text.length > 200, note: 'after reload fire disabled=' + o.a.disabled + '; after back fire disabled=' + o.b.disabled }));
await ctx.close(); await browser.close();
writeFileSync('evidence/stress/recovery.json', JSON.stringify(res, null, 1));
for (const r of res) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + ' | ' + r.note + (r.pageerrors.length ? ' | pageerrors ' + r.pageerrors.join(';') : ''));
