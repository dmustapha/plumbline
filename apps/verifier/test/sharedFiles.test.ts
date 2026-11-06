import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBaseline, loadFloor, readDestroyed, readPin, writePin } from '../src/sharedFiles.ts';
import { BASELINE } from './support.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'plb-sf-'));
const FLOOR_PATH = new URL('../../../policy/floor.yaml', import.meta.url).pathname;

describe('loadBaseline (AG4-VER-8)', () => {
  const put = (body: string): string => { const f = join(tmp(), 'b.json'); writeFileSync(f, body); return f; };
  it('reads a valid manifest', () => expect(loadBaseline(put(JSON.stringify({ resources: BASELINE })))).toEqual(BASELINE));
  it('null for missing, garbage, wrong shape or a malformed entry (never [])', () => {
    expect(loadBaseline('/nonexistent/b.json')).toBeNull();
    expect(loadBaseline(put('nope'))).toBeNull();
    expect(loadBaseline(put('{"resources":"x"}'))).toBeNull();
    expect(loadBaseline(put(JSON.stringify({ resources: [{ id: 'x' }] })))).toBeNull();
    expect(loadBaseline(put(JSON.stringify({ resources: [{ ...BASELINE[0], class: 'bucket' }] })))).toBeNull();
  });
});

describe('readDestroyed (AG4-VER-4)', () => {
  const log = (mode: number, lines: string[]): string => {
    const d = tmp();
    const f = join(d, 'watchdog-actions.jsonl');
    writeFileSync(f, lines.join('\n'));
    chmodSync(f, mode);
    return d;
  };
  const good = JSON.stringify({ act: 'destroyed', id: 'i-1', ts: 5 });
  it('absent file: nothing, no complaint', () => expect(readDestroyed(tmp(), null)).toEqual({ entries: [] }));
  it('reads destroyed entries and skips garbage and other acts', () => {
    const d = log(0o644, [good, 'garbage', JSON.stringify({ act: 'dry-run', id: 'i-2', ts: 6 }), JSON.stringify({ act: 'destroyed', id: 'i-3' })]);
    expect(readDestroyed(d, null)).toEqual({ entries: [{ id: 'i-1', ts: 5 }] });
  });
  it('ignores the whole file when world-writable, a symlink, or owned by another uid', () => {
    expect(readDestroyed(log(0o666, [good]), null).rejected).toContain('world-writable');
    const d = tmp();
    const real = join(tmp(), 'real.jsonl');
    writeFileSync(real, good);
    symlinkSync(real, join(d, 'watchdog-actions.jsonl'));
    expect(readDestroyed(d, null)).toMatchObject({ entries: [], rejected: expect.stringContaining('not a regular file') });
    expect(readDestroyed(log(0o644, [good]), process.getuid!() + 1).rejected).toContain('expected the watchdog uid');
    expect(readDestroyed(log(0o644, [good]), process.getuid!()).entries).toHaveLength(1);
  });
});

describe('loadFloor', () => {
  it('loads the repository floor without a key', () => expect(loadFloor(FLOOR_PATH, '/none', null).floor?.rules.length).toBeGreaterThan(10));
  it('a missing or invalid floor is null with a note (the verdict is then DEGRADED)', () => {
    expect(loadFloor('/nonexistent/floor.yaml', '/none', null)).toMatchObject({ floor: null, note: expect.stringContaining('unreadable') });
    const f = join(tmp(), 'f.yaml');
    writeFileSync(f, 'not: a policy');
    expect(loadFloor(f, '/none', null)).toMatchObject({ floor: null, note: 'floor invalid' });
  });
  it('with a policy key configured, a missing or wrong signature refuses to boot', () => {
    expect(() => loadFloor(FLOOR_PATH, '/nonexistent.sig', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toThrow('BOOT_REFUSED');
  });
});

describe('ledger pin', () => {
  it('round trips and is null when absent or garbled', () => {
    const d = tmp();
    expect(readPin(d)).toBeNull();
    writePin(join(d, 'state'), { seq: 7, row_hash: 'a'.repeat(64) });
    expect(readPin(join(d, 'state'))).toEqual({ seq: 7, row_hash: 'a'.repeat(64) });
    writeFileSync(join(d, 'ledger-pin.json'), '{"seq":"x"}');
    expect(readPin(d)).toBeNull();
  });
});
