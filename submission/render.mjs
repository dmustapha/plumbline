const { chromium } = await import('/opt/homebrew/lib/node_modules/playwright/index.mjs');
import { mkdirSync } from 'node:fs';
const D = '/Users/MAC/vultr-rush/plumbline/app/submission/'; mkdirSync('/tmp/slides', { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + D + 'slides.html'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(2500);
const n = await p.locator('.slide').count();
for (let i = 0; i < n; i++) await p.locator('.slide').nth(i).screenshot({ path: `/tmp/slides/s${String(i + 1).padStart(2, '0')}.png` });
await p.pdf({ path: D + 'slides.pdf', width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
console.log('slides', n); await b.close();
