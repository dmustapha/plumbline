const { chromium } = await import('/opt/homebrew/lib/node_modules/playwright/index.mjs');
const D = '/Users/MAC/vultr-rush/plumbline/app/submission/';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + D + 'cover.html'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(2500);
await p.screenshot({ path: D + 'cover.png' }); await b.close();
