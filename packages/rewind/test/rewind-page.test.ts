import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../../../apps/range-api/public/rewind.html', import.meta.url)), 'utf8');
const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

class El {
  textContent = ''; hidden = false; disabled = false; className = ''; children: El[] = []; handlers: Record<string, () => void> = {};
  constructor(readonly id = '') {}
  appendChild(c: El) { this.children.push(c); return c; }
  addEventListener(ev: string, fn: () => void) { this.handlers[ev] = fn; }
  all(): string { return [this.textContent, ...this.children.map((c) => c.all())].join('\n'); }
}

type Reply = { status?: number; body: unknown };
function boot(routes: Record<string, Reply | (() => Reply)>) {
  const els = new Map<string, El>();
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const document = { getElementById: (id: string) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id) as El; }, createElement: () => new El() };
  const fetch = async (path: string, o: { method: string; body?: string }) => {
    calls.push({ method: o.method, path, body: o.body ? JSON.parse(o.body) : undefined });
    const r = routes[`${o.method} ${path.split('/').slice(0, 3).join('/')}`] ?? { status: 404, body: { status: 'ERROR' } };
    const out = typeof r === 'function' ? r() : r;
    return { status: out.status ?? 200, json: async () => out.body };
  };
  runInNewContext(script, { document, fetch, JSON, encodeURIComponent, Promise });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { els, calls, settle, el: (id: string) => document.getElementById(id) };
}

const listing = {
  versions: [{ versionId: 'v1', isLatest: false, size: 5, lastModified: '2026-11-06T00:01:00Z' }, { versionId: 'v2', isLatest: false, size: 5, lastModified: '2026-11-06T00:02:00Z' }],
  deleteMarkers: [{ versionId: 'dm1', isLatest: true, lastModified: '2026-11-06T00:03:00Z' }],
  fetched_at: '2026-11-06T00:04:00Z',
};

describe('rewind.html', () => {
  it('uses textContent only and declares a viewport', () => {
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) expect(html, bad).not.toContain(bad);
    expect(html).toContain('textContent');
    expect(html).toContain('name="viewport"');
  });
  it('never sends a client-chosen session id (the API binds the caller)', () => {
    expect(script).not.toContain('session_id');
  });
  it('renders the independent S3 listing newest first with the delete marker', async () => {
    const p = boot({ 'GET /api/rewind': { body: { listing, classify: { state_known: true, versions: 2, last_copy: false, has_delete_marker: true }, restore_target: 'v2' } } });
    await p.settle();
    const text = p.el('versions').all();
    expect(text.indexOf('DELETE-MARKER dm1')).toBeLessThan(text.indexOf('VERSION v2'));
    expect(p.el('source').textContent).toContain('ListObjectVersions straight from S3');
    expect(p.el('state').textContent).toContain('rewind target v2');
  });
  it('shows unavailable honestly and disables the buttons, no fake restore', async () => {
    const p = boot({ 'GET /api/rewind': { status: 503, body: { status: 'REWIND_UNAVAILABLE' } } });
    await p.settle();
    expect(p.el('versions').textContent).toContain('not enabled');
    expect(p.el('del').disabled).toBe(true);
    expect(p.el('rew').disabled).toBe(true);
  });
  it('an unknown object state is reported as fail-closed', async () => {
    const p = boot({ 'GET /api/rewind': { body: { listing, classify: { state_known: false }, restore_target: null } } });
    await p.settle();
    expect(p.el('state').textContent).toContain('object state unknown');
  });
  it('a last-copy delete ESCALATE offers approval and posts the nonce against the decision id only', async () => {
    const decided = { status: 'DECIDED', decision: { decision: 'ESCALATE', rule_id: 'last-copy-block', reason: 'this is the last copy of the object', decision_id: 'd-9' }, approval: { nonce: 'n-1' } };
    const p = boot({
      'GET /api/rewind': { body: { listing, classify: { state_known: true, versions: 1, last_copy: true, has_delete_marker: false }, restore_target: null } },
      'POST /api/rewind': { body: decided },
      'POST /api/approval': { body: { status: 'DECIDED', decision: { decision: 'ALLOW', rule_id: 'approved', reason: 'ok', decision_id: 'd-9' } } },
    });
    await p.settle();
    p.el('del').handlers.click?.();
    await p.settle();
    expect(p.el('rwout').textContent).toContain('ESCALATE by rule last-copy-block');
    expect(p.el('approve').hidden).toBe(false);
    p.el('approve').handlers.click?.();
    await p.settle();
    expect(p.calls.find((c) => c.path === '/api/approval/d-9')?.body).toEqual({ nonce: 'n-1', approve: true });
    expect(p.el('approve').hidden).toBe(true);
  });
});
