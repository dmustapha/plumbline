// File: apps/range-api/test/ui.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
