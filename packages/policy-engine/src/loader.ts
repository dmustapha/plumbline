// File: packages/policy-engine/src/loader.ts
import { createHash } from 'node:crypto';
import { LineCounter, isNode, parseDocument } from 'yaml';
import { validateShape } from './schema.ts';
import type { PolicyDoc, Rule } from './types.ts';

export interface PolicyError {
  line: number | null;
  message: string;
}
export type LoadResult = { ok: true; policy: PolicyDoc } | { ok: false; errors: PolicyError[] };

export function hashRules(version: number, rules: Rule[]): string {
  return createHash('sha256').update(JSON.stringify({ version, rules })).digest('hex');
}

export function parsePolicy(text: string, layer: 'session' | 'floor'): LoadResult {
  if (text.length > 64 * 1024) return { ok: false, errors: [{ line: null, message: 'policy larger than 64 KiB' }] };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({ line: e.linePos?.[0]?.line ?? null, message: e.message.split('\n')[0] ?? 'yaml error' })),
    };
  }
  const data = doc.toJS() as unknown;
  const problems = validateShape(data);
  if (problems.length > 0) {
    return {
      ok: false,
      errors: problems.map((p) => {
        const node = doc.getIn(p.path, true);
        const offset = isNode(node) && node.range ? node.range[0] : null;
        return { line: offset === null ? null : lc.linePos(offset).line, message: `${p.path.join('.') || '(root)'}: ${p.message}` };
      }),
    };
  }
  const raw = data as { version: number; rules: Rule[] };
  return { ok: true, policy: { version: raw.version, layer, rules: raw.rules, hash: hashRules(raw.version, raw.rules) } };
}

export function validatePolicy(text: string): { ok: boolean; errors: PolicyError[] } {
  const r = parsePolicy(text, 'session');
  return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors };
}

export function diffRules(a: PolicyDoc, b: PolicyDoc): string[] {
  const out: string[] = [];
  const bm = new Map(b.rules.map((r) => [r.id, r]));
  for (const r of a.rules) {
    const other = bm.get(r.id);
    if (!other) out.push(`- removed ${r.id}`);
    else if (JSON.stringify(other) !== JSON.stringify(r)) out.push(`~ changed ${r.id}: effect ${r.effect} -> ${other.effect}`);
  }
  for (const r of b.rules) if (!a.rules.some((x) => x.id === r.id)) out.push(`+ added ${r.id}`);
  return out;
}
