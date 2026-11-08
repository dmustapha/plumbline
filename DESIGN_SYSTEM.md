# DESIGN_SYSTEM.md

Source of truth: `apps/range-api/public/style.css`. `brand.json` is generated from it by `node scripts/design-tokens.mjs`;
`node scripts/design-tokens.mjs --check` fails if the two drift. Every value below was read from that file, not invented.

## Identity

- **World:** a survey hall at night. Chalk datum marks on graphite; a plumb bob hangs over the live map of a cloud account; gravity is the only judge.
- **Invariant phrase:** *The line hangs true.* (README, `/about`, the landing hero all use it word for word.)
- **Voice:** held / escalated / allowed. "The account did not move." Plain declaratives. No em-dashes anywhere in submission text.
- **Accent:** chalk, `oklch(78% 0.085 230)` = `#7cc2e4` dark, `oklch(48% 0.11 230)` = `#00678f` light. The only chrome accent. One hue (230).
- **Verdict colours are DATA, never chrome:** `--true` green, `--deny` red, `--esc` amber appear only where a verdict, a verifier state or a ceiling is being reported. Red means one thing: a verdict (R9 rule).
- **Signature: THE PLUMBLINE.** A Web Animations API engine, not CSS: `plumbSvg / plumbIdle / plumbTremor / plumbImpact / plumbReconcile` in `app.js`.
  Thesis: the line hangs true while the live Vultr account matches authority; a verdict is a swing the account then has to survive.
- **Per surface:** landing = hero plumb over one real replayed DENY plus the payoff numbers. Console = sidebar shell (ATTACK, MONITOR, CONTAIN, TRUST) with the plumb as the stage between engine authority (left) and Vultr reality (right).

## Tokens

### Colour, dark (default, "night hall")

| role | oklch | hex |
|---|---|---|
| void (page ground) | 15% .008 230 | #080c0e |
| sunken | 11.5% .008 230 | #030507 |
| surface-1 | 20% .009 230 | #121719 |
| surface-2 | 25% .010 230 | #1d2326 |
| surface-3 | 30% .011 230 | #282f32 |
| ink | 95% .006 90 | #f0eeea |
| accent / accent-hi | 78% .085 230 / 86% .07 230 | #7cc2e4 / #a2daf6 |
| true / deny / esc (data) | 80% .17 160 / 66% .22 20 / 82% .15 80 | #30de97 / #fc4257 / #f7b83d |
| on-accent | 16% .02 230 | #050f14 |

### Colour, light ("survey paper", overrides only)

void #f3f2ed, sunken #e6e4df, surface-1 #fcfcf9, surface-2/3 #ffffff, ink #151c1f, accent #00678f, accent-hi #005681, true #007b44, deny #c50031, esc #ab7400, on-accent #f9f8f5.
Theme switch: `data-theme="dark|light"` on `<html>`, persisted in `localStorage['plb-theme']`; an anti-FOUC script is the first thing in every `<head>`.

### Type

| role | family | weight | use |
|---|---|---|---|
| display | Barlow Semi Condensed | 600, tracking -0.015em, line-height .94 | h1-h3, the survey-instrument voice |
| body | Geist | 400 (500/600 for emphasis) | prose |
| instrument | Geist Mono | 400/500, ligatures off, tabular lining numerals | numbers, ids, eyebrows (uppercase, .2em tracking) |

Scale: hero `clamp(3rem, 5vw, 4.75rem)`, title `clamp(2.5rem, 3.8vw, 3.75rem)`, sub `clamp(1.25rem, 1.3vw + .6rem, 1.75rem)`, lead 1.1875rem, body .9375rem, small .8125rem, micro .71875rem.
Fonts load from Google Fonts via one `<link>` (Barlow Semi Condensed 500/600/700, Geist 400/500/600, Geist Mono 400/500/600, `display=swap`); each has a system fallback stack.

### Spacing (4px base) and radii

Spacing: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 (`--s-1` to `--s-10`).
Radii: 1 (`--r-tick`, severity ticks), 4 (`--r-chip`, badges and code chips), 6 (`--r-1`), 10 (`--r-2`), 16 (`--r-card`), 22 (`--r-lift`), 999 (`--r-pill`), plus 50% for dots. No literal radius appears in component rules (CF-1 clean).

### Ready-to-paste `@theme`

```css
@theme {
  --color-void: oklch(15% 0.008 230);   --color-sunken: oklch(11.5% 0.008 230);
  --color-surface-1: oklch(20% 0.009 230); --color-surface-2: oklch(25% 0.010 230); --color-surface-3: oklch(30% 0.011 230);
  --color-ink: oklch(95% 0.006 90);     --color-accent: oklch(78% 0.085 230);
  --color-true: oklch(80% 0.17 160);    --color-deny: oklch(66% 0.22 20);    --color-esc: oklch(82% 0.15 80);
  --font-display: "Barlow Semi Condensed", "Archivo Narrow", system-ui, sans-serif;
  --font-body: "Geist", "Inter", system-ui, sans-serif;
  --font-mono: "Geist Mono", "JetBrains Mono", ui-monospace, monospace;
  --radius-1: 6px; --radius-2: 10px; --radius-card: 16px; --radius-lift: 22px;
}
/* light: redefine under [data-theme="light"] with the light table above */
```

### Do / Don't

- Do keep chalk as the only chrome accent. Don't use true/deny/esc for buttons, links or decoration.
- Do separate levels by background step plus a hairline. Don't add neutral drop shadows to in-flow surfaces.
- Do take every number from `/api/proof`, `/api/verify`, `/api/replay`. Don't type a statistic into markup.
- Don't use innerHTML, outerHTML, insertAdjacentHTML or document.write (bound by `ui.test.ts`).

## Status Legend

| colour | token | meaning |
|---|---|---|
| green `#30de97` | ALLOW / GREEN | the engine allowed it, or the second host read the account as matching authority |
| red `#fc4257` | DENY / RED | the engine refused (the account did not move), or the verifier names an unauthorised resource |
| amber `#f7b83d` | ESCALATE / DEGRADED | a human decision is required, or a host is unreachable (the line goes ghost, "UNDER TEST") |
| chalk `#7cc2e4` | (chrome) | navigation, focus, links, REPLAY badge. Never a verdict |

## Craft

### Elevation doctrine (bg-step ladder + hairline + one coloured ambient glow)

| level | recipe | used by |
|---|---|---|
| sunken | `--lv-sunken`: inset 0 2px 4px black 35% + 1px hairline ring, background `--sunken` | sidebar, inputs |
| flat | page ground `--void`, no shadow | body |
| raised | `--lv-raised`: inset 0 1px 0 ink 10%, `--card` gradient (surface-2 to surface-1), 1px hairline, r 16 | `.panel` |
| lifted | `--lv-lifted-{true,deny,esc}`: inset highlight + 1px under-edge + `0 48px 140px -48px` glow in the verdict colour, `--card-lift`, r 22 | `.panel.stage` only (the set-piece) |
| floating | not implemented (the site has no overlays; the dead token was removed) | none |
| protruding | not implemented | none |

Exactly one coloured glow sits on the page, on the stage; it follows the verdict (`html[data-m="red|amber"]`). No glass: `backdrop-filter` count is 0.

### Hover / focus

- Hover: panels `translateY(-2px)` + border to accent 25%; buttons `translateY(-1px)` + border accent 40%; nav links `translateX(2px)` + ink 4% wash; ledger rows ink 4% wash. All transitions use `--ease-quart`, 160ms.
- Focus-visible: 2px solid `--accent-hi`, offset 2px, radius 4. Inputs: border accent + 3px accent 14% ring.

### Controls

Primary: accent fill, `--on-accent` text, small accent glow. FIRE: ink fill, mono uppercase, `.14em` tracking (ink, not red: red is verdict only). Ghost: transparent, accent text.

## Primitives

`.panel` (raised card), `.panel.stage` (lifted set-piece), `.two` / `.grid` (equal columns, stack under 1000 / 760px), `.badge.{ALLOW,GREEN,DENY,RED,ESCALATE,DEGRADED,REPLAY}`, `.ladder` (ruled attack list with a 5-tick severity gauge `.sev`), `.tablewrap` + ledger table (mono, 12/14px cells), `.card.v-{DENY,ALLOW,ESCALATE}`, `.strip` (64px sticky truth strip), `aside.side` (236px sidebar).

## Motion

| name | spec | where |
|---|---|---|
| idle sway | WAAPI, 4200ms alternate, +-0.45deg | plumb at rest |
| tremor | 110ms alternate, +-2.6deg | attack in flight (state UNDER TEST) |
| DENY swing | 2100ms, 40-step damped cosine, amplitude 15deg, decay e^-3.4t, 2.6 cycles | verdict lands |
| ALLOW swing | same curve, amplitude 7deg | |
| ESCALATE | 500ms ease to 6deg, held | |
| RED hold | cord held off-true at 13deg | verifier names an unauthorised resource |
| ghost | line dims, state UNDER TEST / UNREAD | broker or verifier unreachable |
| lamp pulse on DENY | 1500ms opacity .34 to .9 to .34 | ground lamp |
| lamp breathe | 11s ease-sine | ground |
| arrive / fadeInUp / cardin / rowFlash / settleTrue | .7s / .9s / .5s / 1.6s / 3.2s, `--ease-quart` | page entry, new rows |

Eases: out `cubic-bezier(.16,1,.3,1)`, quart `(.22,1,.36,1)`, back `(.34,1.26,.64,1)`, sine `(.36,0,.64,1)`. Durations: fast 160ms, med 420ms, slow 900ms.
Reduced motion is two-sided: 8 `prefers-reduced-motion` blocks gate every ambient loop, and the verdict still changes state without the swing.

### The plumb appearance rule

The full-scale plumb (the WAAPI engine, 74px+ gutter, swinging) appears **exactly four times on the site**: landing hero, `/range` stage, `/verify` reconcile stage, landing closer. Wallpapering it failed (R18). Two derived glyphs exist and do not count as appearances: the 22x28px brand mark in the shell (idle sway only) and the 16x22px micro-plumb in ledger rows (static, tilted by verdict). No other page gets a plumb.

## No-furniture list

No horizontal-bar family (progress bars, bar charts, stat bars; severity is a 5-tick gauge, spend is a bob on a rule). No square grid backdrop (a sparse crosshair datum field instead). No glass or backdrop blur. No neutral drop shadows. No gradient text. No motif wallpaper. No emoji. No second accent hue. No stock icon set (state dots and hairlines only). Atmosphere stays recessed: grain 7% (5% light), datum field 60% opacity, lamp 34%.

## Logo

Pending Phase 3. Concept: a plumb bob hanging true; chalk cord, true-green bob, graphite ground; must survive 16px favicon, 32px nav mark, 512px social and one-colour mono. To be generated with image gen and chosen by Dami, not by the agent.
