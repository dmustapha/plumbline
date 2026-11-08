// File: apps/range-api/test/ui.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const dir = new URL('../public', import.meta.url).pathname;
const files = readdirSync(dir);
const html = files.filter((f) => f.endsWith('.html'));
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
const MINE = ['index', 'range', 'policy', 'proof', 'about', 'replay', 'status'];

describe('web UI shell', () => {
  it('ships the seven pages of this stream plus app.js and style.css', () => {
    for (const p of MINE) expect(html, p).toContain(`${p}.html`);
    expect(files).toContain('app.js');
    expect(files).toContain('style.css');
  });

  it('every page has a viewport meta tag and loads the shared script', () => {
    for (const f of html) {
      expect(read(f), f).toContain('name="viewport"');
      expect(read(f), f).toContain('<script src="/app.js">');
    }
  });

  it('no file builds markup from a string: zero innerHTML / outerHTML / insertAdjacentHTML / document.write', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('every page this stream owns has the trust-root mount, and /range and /verify get the verifier line from app.js', () => {
    for (const p of MINE) expect(read(`${p}.html`), p).toContain('id="trust"');
    expect(read('verify.html')).toContain('id="trust"');
    const js = read('app.js');
    expect(js).toContain('trust-verifier');
    expect(js).toContain("$('#vprodout')");
  });

  it("/range has a slot for the second host's own read of prod-db, and verdict cards carry one", () => {
    expect(read('range.html')).toMatch(/id="prodread"[^>]*prodread-slot/);
    expect(read('app.js')).toMatch(/prodread-slot/);
  });

  it('CO-2 E-2: the playground is a VPC in every label and prompt, never a firewall group', () => {
    const text = ['range.html', 'policy.html', 'app.js'].map(read).join('\n');
    expect(text).toContain('playground VPC');
    expect(text).not.toMatch(/vault firewall group/i);
    expect(text).not.toMatch(/playground firewall/i);
  });

  it('the session key never reaches page script: no storage of a key and no key header in app.js', () => {
    const js = read('app.js');
    expect(js).not.toMatch(/plb_key|x-plumbline-session-key/);
  });

  it('works at 400px: single column below 760px and wide blocks scroll inside their own box', () => {
    const css = read('style.css');
    expect(css).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.grid\s*\{\s*grid-template-columns: 1fr/);
    expect(css).toMatch(/pre \{[^}]*overflow-x:auto/);
  });
});

describe('CSP (design-forge DF-CSP)', () => {
  it('builds a script-src from the inline scripts actually in the page and forbids framing and foreign connects', async () => {
    const { pageCsp } = await import('../src/routes.ts');
    const { createHash } = await import('node:crypto');
    const body = 'var a=1;';
    const csp = pageCsp(`<head><script>${body}</script></head><script src="/app.js"></script>`);
    expect(csp).toContain(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
  it('every shipped page has only hash-covered inline scripts (no inline event attributes)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../public/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(dir + f, 'utf8');
      expect(html, f).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    }
  });
});

describe('brand assets (design-forge logo)', () => {
  const ROUTES: Record<string, string> = { '/logo.svg': 'image/svg+xml', '/logo-mono.svg': 'image/svg+xml', '/logo-lockup.svg': 'image/svg+xml', '/favicon.svg': 'image/svg+xml', '/favicon-32.png': 'image/png', '/favicon.ico': 'image/png', '/og-image.png': 'image/png' };
  it('serves each brand asset at an explicit route with the right type and a locked-down SVG policy', async () => {
    const { makeApi, fakeBroker } = await import('./support.ts');
    const { app } = await makeApi(fakeBroker());
    for (const [url, type] of Object.entries(ROUTES)) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(String(r.headers['content-type']), url).toContain(type);
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      if (url.endsWith('.svg')) expect(String(r.headers['content-security-policy']), url).toContain("default-src 'none'");
    }
    const png = await app.inject({ method: 'GET', url: '/og-image.png' });
    expect(png.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
  it('is still a whitelist: a neighbouring name or a traversal does not serve a file', async () => {
    const { makeApi, fakeBroker } = await import('./support.ts');
    const { app } = await makeApi(fakeBroker());
    for (const url of ['/logo.svg.bak', '/logo-v1.svg', '/public/logo.svg', '/%2e%2e/%2e%2e/etc/passwd', '/logo.svg/../../app.js.map', '/evidence/design-forge/logo-candidates/B1.png']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
    }
  });
  it('every page head carries the icon links and Open Graph tags, after the anti-FOUC theme script', () => {
    for (const f of html) {
      const t = readFileSync(join(dir, f), 'utf8');
      expect(t, f).toContain('rel="icon" href="/favicon.svg"');
      expect(t, f).toContain('property="og:image"');
      expect(t.indexOf("localStorage.getItem('plb-theme')"), f).toBeGreaterThan(-1);
      expect(t.indexOf("localStorage.getItem('plb-theme')"), f).toBeLessThan(t.indexOf('rel="icon"'));
    }
  });
  it('the shipped SVGs carry no script and no external reference', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.svg'))) {
      const t = readFileSync(join(dir, f), 'utf8');
      expect(t, f).not.toMatch(/<script|href\s*=\s*["']https?:|xlink:href|onload=/i);
    }
  });
});

describe('product framing for the real users (platform leads first)', () => {
  it('the landing states the platform-team claim, labels the demo account and links the run-it-yourself page', () => {
    const idx = read('index.html');
    expect(idx).toContain('FOR TEAMS GIVING AI AGENTS CLOUD ACCESS');
    expect(idx).toContain('demo account we own');
    expect(idx).toContain('href="/run"');
    expect(idx).toContain('id="whofor"');
  });
  it('/run exists, is registered as a route, and covers setup, keys, policy, approvals, audit and the scope', () => {
    expect(html).toContain('run.html');
    expect(readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8')).toContain("'/run': 'run.html'");
    const run = read('run.html');
    for (const h of ['Set it up', 'Where your keys live', 'Write your policy', 'Approvals', 'Audit your account', 'What you get today, and what you do not']) expect(run, h).toContain(h);
  });
  it('the safety model defines every unfamiliar term in plain words and states the release scope', () => {
    const about = read('about.html');
    for (const t of ['Broker', 'Policy engine', 'Floor', 'Escalate', 'Verifier', 'Watchdog', 'Tier', 'Ceiling', 'Bond', 'Rewind', 'Drift']) expect(about, t).toContain(`<dt>${t}</dt>`);
    expect(about).toContain('What this release is, and is not');
  });
  it('the metaphor labels were replaced by plain ones, and the verdict panel leads with one plain sentence', () => {
    const js = read('app.js');
    for (const old of ['HANGING TRUE', 'OFF PLUMB', 'AUTHORITY · ENGINE', 'REALITY · VULTR', 'ANGLE OFF TRUE']) expect(js, old).not.toContain(old);
    for (const now of ['NO DRIFT', 'WHAT POLICY SAYS', 'WHAT VULTR SHOWS', 'DRIFT FROM POLICY', 'plainverdict']) expect(js, now).toContain(now);
  });
});

describe('plain words on every page and no leftover metaphor copy', () => {
  it('every working page opens with a plain-words line', () => {
    for (const f of ['status', 'bond', 'policy', 'rewind', 'proof', 'verify', 'replay']) expect(read(`${f}.html`), f).toContain('class="plainline"');
  });
  it('no user-facing page says the line hangs true, the bob, or off plumb (comments excepted)', () => {
    for (const f of html) expect(read(f), f).not.toMatch(/hangs true|off plumb/i);
    const code = read('app.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/\/\/ .*$/gm, '');
    for (const bad of ['the line hangs true', 'the line is off plumb', 'the bob rises', 'the bob stays', 'the bob:']) expect(code, bad).not.toContain(bad);
  });
  it('/run covers adoption: prerequisites, how an agent plugs in, supported clouds, support, and that the strip is the demo', () => {
    const run = read('run.html');
    for (const t of ['Read this first', 'Before you start', 'How your agent plugs in', 'Only the Vultr adapter exists', 'Questions and support']) expect(run, t).toContain(t);
  });
  it('the safety model defines compliant-operator mode and rung/gate in plain words', () => {
    const about = read('about.html');
    expect(about).toContain('<dt>Compliant-operator mode</dt>');
    expect(about).toContain('<dt>Rung and gate</dt>');
  });
});

describe('the shipped script is valid JavaScript', () => {
  it('app.js parses (a syntax error blanks every page)', () => {
    expect(() => new Script(read('app.js'), { filename: 'app.js' })).not.toThrow();
  });
  it('every inline script in every page parses', () => {
    for (const f of html) for (const m of read(f).matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Script(m[1] as string, { filename: f }), f).not.toThrow();
  });
});

