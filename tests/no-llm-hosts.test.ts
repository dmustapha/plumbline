// File: tests/no-llm-hosts.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const FORBIDDEN = [/api\.openai\.com/i, /anthropic/i, /generativelanguage/i, /api\.groq/i, /api\.together/i, /mistral\.ai/i, /cohere\.(ai|com)/i, /huggingface/i, /openrouter/i, /from\s+'openai'/, /from\s+'@anthropic-ai/, /deepseek-v4/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (['node_modules', 'test', 'evidence'].includes(name)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|py|js|html|sh)$/.test(name)) out.push(p);
  }
  return out;
}

describe('AC-ALL-2 inference hosts', () => {
  const files = ['packages', 'apps', 'ops'].flatMap((d) => walk(`${root}${d}`));
  it('no other LLM host, SDK or unapproved model id appears in source', () => {
    for (const f of files) for (const re of FORBIDDEN) expect(readFileSync(f, 'utf8'), `${f} matches ${re}`).not.toMatch(re);
  });
  it('the Vultr inference host appears only in packages/vultr-adapter/src/vsi.ts', () => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('api.vultrinference.com'));
    expect(hits.map((f) => f.replace(root, ''))).toEqual(['packages/vultr-adapter/src/vsi.ts']);
  });
  it('only the three approved model ids are named in source', () => {
    const ids = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/'((?:glm|qwen|nemotron|deepseek|llama|gpt|mistral)[a-z0-9.\-]*)'/g)) ids.add(m[1] as string);
    expect([...ids].sort()).toEqual(['glm-5.3', 'nemotron-3.5-content-safety', 'qwen3.8-27b']);
  });
});
