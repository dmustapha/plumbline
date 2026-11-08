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

describe('structure for the real users (platform leads first)', () => {
  const NEW_PAGES = ['index', 'range', 'policy', 'status', 'recovery', 'replay', 'verify', 'proof', 'about', 'architecture', 'concepts', 'integrate', 'deploy'];
  it('ships every page of the six-part structure and no page of the old layout that was merged away', () => {
    for (const p of NEW_PAGES) expect(html, p).toContain(`${p}.html`);
    expect(html).not.toContain('rewind.html'); expect(html).not.toContain('bond.html'); expect(html).not.toContain('run.html');
  });
  it('the route table maps the new addresses and redirects the old ones', () => {
    const r = readFileSync(new URL('../src/routes.ts', import.meta.url), 'utf8');
    for (const route of ["'/try'", "'/controls/policy'", "'/controls/limits'", "'/controls/recovery'", "'/audit/ledger'", "'/audit/reconcile'", "'/audit/evidence'", "'/docs/safety'", "'/docs/architecture'", "'/docs/concepts'", "'/docs/integrate'", "'/deploy'"]) expect(r, route).toContain(route);
    expect(r).toContain('MOVED');
  });
  it('the overview states the platform-team claim, labels the demo and routes each audience to its pages', () => {
    const idx = read('index.html');
    expect(idx).toContain('FOR PLATFORM TEAMS GIVING AI AGENTS CLOUD ACCESS');
    expect(idx).toContain('demo account we own');
    for (const id of ['procard', 'guarantees', 'flow', 'whofor', 'honest']) expect(idx, id).toContain(`id="${id}"`);
    for (const href of ['/try?fire=prod', '/deploy', '/docs/architecture', '/docs/integrate', '/audit/reconcile']) expect(idx, href).toContain(`href="${href}"`);
    expect(idx).not.toMatch(/blast radius at zero/i);
  });
  it('the navigation uses the six groups and the new addresses', () => {
    const js = read('app.js');
    for (const g of ["'TRY IT'", "'CONTROLS'", "'AUDIT'", "'DOCS'", "'DEPLOY'"]) expect(js, g).toContain(g);
    for (const h of ['/try', '/controls/policy', '/controls/limits', '/controls/recovery', '/audit/ledger', '/audit/reconcile', '/audit/evidence', '/docs/safety', '/docs/architecture', '/docs/concepts', '/docs/integrate', '/deploy']) expect(js, h).toContain(`'${h}'`);
  });
  it('every page that shows our demo account carries the scope note', () => {
    expect(read('app.js')).toMatch(/DEMO_SCOPE = new Set\(\['range', 'policy', 'status', 'recovery', 'replay', 'verify', 'proof'\]\)/);
  });
  it('recovery merges the undo and the bond, with both scripts and no duplicate element ids', () => {
    const rec = read('recovery.html');
    for (const id of ['undo', 'bond', 'del', 'rew', 'bondout', 'burnlist']) expect(rec, id).toContain(`id="${id}"`);
    const ids = [...rec.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]); expect(new Set(ids).size).toBe(ids.length);
  });
  it('the docs pages exist with their content: architecture, concepts, integration contract, deploy', () => {
    const arch = read('architecture.html'); for (const t of ['The components', 'One request, start to finish', 'Trust boundaries', 'role="img"']) expect(arch, t).toContain(t);
    const con = read('concepts.html'); for (const t of ['Broker', 'Policy engine', 'Floor', 'Escalate', 'Verifier', 'Watchdog', 'Tier', 'Spend limit', 'Kill switch', 'Bond', 'Rewind', 'Ledger', 'Rung and gate', 'Compliant-operator mode']) expect(con, t).toContain(`<dt>${t}</dt>`);
    const int = read('integrate.html'); for (const t of ['POST /v1/call', 'AUTH_TASK_TOKEN_INVALID', 'ARGS_INVALID', 'ESCALATE']) expect(int, t).toContain(t);
    const dep = read('deploy.html'); for (const t of ['Before you start', 'Set it up', 'Where your keys live', 'Write your policy', 'Plug in your agent', 'Approvals', 'Audit your account', 'Status and roadmap', 'class="glance"']) expect(dep, t).toContain(t);
  });
  it('the safety model keeps claims, non-claims and scope and points to Concepts for the vocabulary', () => {
    const about = read('about.html'); expect(about).toContain('What this release is, and is not'); expect(about).toContain('/docs/concepts'); expect(about).not.toContain('<dt>');
  });
  it('colour semantics: DENY is a calm block colour, red is reserved for a differing account or an error', () => {
    const css = read('style.css');
    expect(css).toMatch(/\.badge\.DENY \{[^}]*var\(--block/); expect(css).not.toMatch(/\.badge\.DENY[^{]*\{[^}]*var\(--deny/);
    expect(css).toMatch(/\.badge\.ALLOW \{[^}]*var\(--ink/);
  });
  it('the swinging gauge is gone from the pages: a reconcile table with match chips replaces it', () => {
    const js = read('app.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const t of ["'What Vultr shows'", "'What policy says'", "'MATCHES'", "'DIFFERS'", 'MATCHES POLICY']) expect(js, t).toContain(t);
    for (const old of ['HANGING TRUE', 'OFF PLUMB', 'AUTHORITY · ENGINE', 'REALITY · VULTR', 'ANGLE OFF TRUE', 'THE PLUMBLINE', 'DRIFT FROM POLICY']) expect(js, old).not.toContain(old);
    expect(js).toContain('plainverdict');
  });
});

describe('plain words on every page and no leftover metaphor copy', () => {
  it('every working page opens with a plain-words line', () => {
    for (const f of ['status', 'policy', 'proof', 'verify', 'replay', 'recovery']) expect(read(`${f}.html`), f).toContain('class="plainline"');
  });
  it('no user-facing page says the line hangs true, the bob, or off plumb (comments excepted)', () => {
    for (const f of html) expect(read(f), f).not.toMatch(/hangs true|off plumb/i);
    const code = read('app.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').replace(/\/\/ .*$/gm, '');
    for (const bad of ['the line hangs true', 'the line is off plumb', 'the bob rises', 'the bob stays', 'the bob:']) expect(code, bad).not.toContain(bad);
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

describe('honest readings and no needless errors', () => {
  it('the proof page mints a session only when a live probe is pressed', () => {
    const js = read('app.js'); const i = js.indexOf('async containment()'); const body = js.slice(i, js.indexOf('async policy()', i));
    expect(body).not.toMatch(/^\s*if \(!\(await ensureSession\(\)\)\) return;\s*$/m);
    expect((body.match(/ensureSession\(\)/g) ?? []).length).toBe(2);
  });
  it('the session-limit message says what to do instead of printing a status code', () => {
    expect(read('app.js')).toContain('maximum of live demo sessions');
  });
});

describe('the ledger is built for the audit job', () => {
  it('filters by verdict and rule, hides system housekeeping by default, pages 50 at a time, and offers the export', () => {
    const h = read('replay.html'); const js = read('app.js');
    for (const t of ['data-f="DENY"', 'data-f="ESCALATE"', 'id="lrule"', 'id="lsys"', 'id="lmore"', 'href="/ledger/export"']) expect(h, t).toContain(t);
    expect(js).toContain("sys: false"); expect(js).toContain('F.page * 50'); expect(js).toContain("api('/api/replay?limit=400')");
  });
  it('the reconcile table adapts to its own width and never depends on the window', () => {
    const css = read('style.css'); expect(css).toContain('container-type: inline-size'); expect(css).toContain('@container (max-width: 620px)');
  });
});

