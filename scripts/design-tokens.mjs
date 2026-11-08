// File: scripts/design-tokens.mjs
// Builds brand.json from apps/range-api/public/style.css (the single source of truth) and, with --check,
// fails if the committed brand.json drifts from it. Usage: node scripts/design-tokens.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'apps/range-api/public/style.css';
const OUT = 'brand.json';
const css = readFileSync(CSS, 'utf8');

function block(sel) {
  const i = css.indexOf(sel + ' {'); if (i < 0) throw new Error('missing block ' + sel);
  let d = 0, j = css.indexOf('{', i);
  for (let k = j; k < css.length; k++) { if (css[k] === '{') d++; if (css[k] === '}' && --d === 0) return css.slice(j + 1, k); }
  throw new Error('unterminated ' + sel);
}
const vars = (txt) => Object.fromEntries([...txt.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = vars(block(':root, [data-theme="dark"]'));
const light = vars(block('[data-theme="light"]'));
const shared = vars(block(':root'));

function oklchToHex(s) {
  const m = s.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/); if (!m) return null;
  const L = +m[1] / 100, C = +m[2], h = (+m[3] * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, mm = m_ ** 3, ss = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss, -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * ss];
  const g = (x) => { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
  return '#' + lin.map((x) => Math.round(g(x) * 255).toString(16).padStart(2, '0')).join('');
}
const roles = ['void', 'sunken', 'surface-1', 'surface-2', 'surface-3', 'ink', 'accent', 'accent-hi', 'true', 'deny', 'esc', 'on-accent'];
const theme = (v) => Object.fromEntries(roles.map((r) => [r, { oklch: v[r] ?? dark[r], hex: oklchToHex(v[r] ?? dark[r]) }]));
const px = (v) => parseInt(v, 10);
const pick = (pre) => Object.fromEntries(Object.entries(shared).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]));
const fam = (v) => v.split(',')[0].replace(/["']/g, '').trim();

const brand = {
  name: 'Plumbline', tagline: 'Blast Radius Zero: attack an agent that holds a live Vultr account.',
  colorMode: 'both', source: CSS,
  brandColor: oklchToHex(dark.accent), accent: oklchToHex(dark.accent), accentOklch: dark.accent,
  ink: ['void', 'sunken', 'surface-1', 'surface-2', 'surface-3'].map((r) => oklchToHex(dark[r])),
  themes: { dark: theme(dark), light: theme(light) },
  semantic: { success: oklchToHex(dark.true), warning: oklchToHex(dark.esc), danger: oklchToHex(dark.deny) },
  fonts: { display: fam(shared['f-display']), body: fam(shared['f-body']), mono: fam(shared['f-mono']) },
  fontWeights: { display: 600, body: 400, mono: 500 },
  spacing: pick('s-'), radii: pick('r-'), typeScale: pick('t-'),
  motion: { eases: pick('ease-'), durations: pick('dur-') },
  shadowPhilosophy: 'soft-elevation',
  signatureElement: 'The Plumbline: a WAAPI plumb bob that hangs true over the live account and swings on every verdict',
  signatureObject: {
    name: 'THE PLUMBLINE',
    thesis: 'Gravity is the only judge: the line hangs true while the live Vultr account matches authority, and a verdict is a swing the account then has to survive.',
    perSurface: { landing: 'hero plumb over one real replayed DENY and the payoff numbers', console: 'sidebar shell (ATTACK, MONITOR, CONTAIN, TRUST) with the plumb as the stage between engine authority and Vultr reality' },
  },
  invariantPhrase: 'The line hangs true.',
  statusLegend: [
    { color: oklchToHex(dark.true), token: 'ALLOW / GREEN', meaning: 'engine allowed it, or the second host read the account as matching authority' },
    { color: oklchToHex(dark.deny), token: 'DENY / RED', meaning: 'the engine refused (the account did not move), or the verifier names an unauthorised resource' },
    { color: oklchToHex(dark.esc), token: 'ESCALATE / DEGRADED', meaning: 'a human decision is required, or a host is unreachable (the line goes ghost)' },
  ],
  logoPath: null,
};
const text = JSON.stringify(brand, null, 2) + '\n';
if (process.argv.includes('--check')) {
  let cur = ''; try { cur = readFileSync(OUT, 'utf8'); } catch {}
  const strip = (t) => { const o = JSON.parse(t || '{}'); delete o.logoPath; return JSON.stringify(o); };
  if (strip(cur) !== strip(text)) { console.error('brand.json DRIFTS from style.css (run: node scripts/design-tokens.mjs)'); process.exit(1); }
  console.log('brand.json matches style.css'); process.exit(0);
}
let prev = {}; try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
if (prev.logoPath) brand.logoPath = prev.logoPath;
writeFileSync(OUT, JSON.stringify(brand, null, 2) + '\n'); console.log('wrote', OUT);
