// File: tests/stress/viewports.mjs
// Stress phase 3: every page x 5 viewports. Measures horizontal overflow, console errors, failed requests and axe (wcag2a/aa/21aa).
// Usage: PLUMBLINE_URL=https://... PAGES=/,/verify node tests/stress/viewports.mjs   (AXE=/path/to/axe.min.js, SHOTS=1 for screenshots of the P0 pages)
// playwright is not a project dependency: point PLAYWRIGHT at a global install (npm root -g)/playwright/index.mjs when it is not resolvable
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.PLUMBLINE_URL ?? 'https://plumbline.108-61-70-169.sslip.io';
const PAGES = (process.env.PAGES ?? '/,/verify,/replay,/status,/proof,/about').split(',');
const VPS = [320, 768, 1024, 1440, 1920];
const P0 = new Set(['/', '/try', '/audit/reconcile']);
const AXE = process.env.AXE;
const out = []; mkdirSync('evidence/stress', { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ bypassCSP: true, colorScheme: process.env.THEME === 'light' ? 'light' : 'dark' });
// the app is dark by default and keeps the choice under plb-theme
if (process.env.THEME === 'light') await ctx.addInitScript(() => { try { localStorage.setItem('plb-theme', 'light'); } catch (e) {} });
for (const path of PAGES) for (const w of VPS) {
  const page = await ctx.newPage(); const errs = []; const bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 140)));
  page.on('requestfailed', (r) => bad.push(r.url().slice(0, 100)));
  await page.setViewportSize({ width: w, height: w < 600 ? 800 : 900 });
  await page.goto(BASE + path + '?cb=' + Date.now(), { waitUntil: 'load' }).catch((e) => errs.push('GOTO ' + e.message.slice(0, 100)));
  await page.waitForTimeout(4500);
  const m = await page.evaluate(() => {
    const de = document.documentElement; const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('#ground,.tablewrap,pre,textarea,aside.side,a.skip,.sr-only'); }).slice(0, 4).map((e) => e.tagName + '.' + (e.className.baseVal ?? e.className) + '@' + Math.round(e.getBoundingClientRect().right));
    const small = [...document.querySelectorAll('a,button,select,input,textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24) && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.sr-only,a.skip'); }).length;
    return { iw: innerWidth, sw: de.scrollWidth, overflow: de.scrollWidth > innerWidth + 1, wide, smallTargets: small };
  });
  let axe = null;
  if (AXE) { await page.addScriptTag({ path: AXE }); axe = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] }); return r.violations.map((v) => ({ id: v.id, n: v.nodes.length })); }); }
  if (process.env.SHOTS && P0.has(path)) await page.screenshot({ path: `evidence/stress/vp-${path === '/' ? 'landing' : path.slice(1)}-${w}.png` });
  out.push({ path, w, ...m, errs: errs.length ? errs : undefined, failedRequests: bad.length ? bad : undefined, axe });
  await page.close();
}
await browser.close();
writeFileSync(process.env.OUT ?? 'evidence/stress/viewports.json', JSON.stringify(out, null, 1));
const bad = out.filter((r) => r.overflow || r.errs || r.failedRequests || (r.axe && r.axe.length));
for (const r of out) console.log(`${r.path.padEnd(14)} ${String(r.w).padStart(4)}  overflow:${r.overflow ? 'YES ' + JSON.stringify(r.wide) : 'no'}  smallTargets:${r.smallTargets}  errs:${r.errs?.length ?? 0}  axe:${r.axe ? r.axe.length : 'n/a'}`);
console.log(`${out.length} page-viewports, ${bad.length} with a finding`);
