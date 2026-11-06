// File: tests/boundary-lint.test.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const ENGINE = '@plumbline/policy-engine';
const ALLOWED: Record<string, string[]> = {
  'packages/policy-engine': [],
  'packages/ledger': [ENGINE],
  'packages/vultr-adapter': [ENGINE, '@plumbline/ledger'],
  'packages/sandbox': [],
  'packages/operator': [],
  'packages/rewind': [],
  'packages/attacks': [ENGINE],
  'apps/broker': [ENGINE, '@plumbline/ledger', '@plumbline/vultr-adapter', '@plumbline/rewind'],
  'apps/runner': ['@plumbline/sandbox'],
  'apps/range-api': ['@plumbline/operator', ENGINE],
  'apps/verifier': [ENGINE, '@plumbline/ledger', '@plumbline/vultr-adapter'],
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out; // streams not yet built (DEV: tolerate missing dirs before fan-out)
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|py)$/.test(name)) out.push(p);
  }
  return out;
}

describe('dependency boundaries', () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    it(`${pkg} imports only ${allowed.length ? allowed.join(', ') : 'third-party and relative modules'}`, () => {
      for (const file of walk(`${root}${pkg}/src`)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/from\s+'(@plumbline\/[a-z-]+)'/g)) {
          expect(allowed, `${file} imports ${m[1]}`).toContain(m[1]);
        }
      }
    });
  }
  it('the engine performs no I/O, reads no environment and has no clock or randomness', () => {
    for (const file of walk(`${root}packages/policy-engine/src`)) {
      const text = readFileSync(file, 'utf8');
      for (const bad of ['node:fs', 'node:net', 'node:http', 'node:child_process', 'process.env', 'Date.now', 'Math.random', 'fetch(', 'setTimeout']) {
        expect(text, `${file} contains ${bad}`).not.toContain(bad);
      }
    }
  });
  it('Vultr hostnames and ACL strings live only in packages/vultr-adapter', () => {
    for (const pkg of Object.keys(ALLOWED).filter((p) => p !== 'packages/vultr-adapter')) {
      for (const file of walk(`${root}${pkg}/src`)) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/api\.vultr\.com|api\.vultrinference\.com|vultrobjects\.com/);
        expect(text, file).not.toMatch(/subscriptions_view/);
      }
    }
  });
  it('no module outside the adapter constructs a raw fetch to a cloud API or an authenticated Vultr client', () => {
    for (const pkg of ['apps/range-api', 'packages/operator', 'packages/sandbox']) {
      for (const file of walk(`${root}${pkg}/src`)) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/VultrHttp|OwnerAdmin|TierKeys|VsiClient|S3Store/);
      }
    }
  });
});
