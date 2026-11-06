// File: packages/rewind/test/rewind.test.ts
import { describe, expect, it } from 'vitest';
import { classifyDelete, proofLines, restoreTarget, restoredCorrectly, type ListingLike } from '../src/index.ts';

const v = (id: string, t: string, latest = false) => ({ versionId: id, isLatest: latest, size: 9, lastModified: `2026-11-06T00:0${t}:00Z` });
const two: ListingLike = { versions: [v('v1', '1'), v('v2', '2', true)], deleteMarkers: [], fetched_at: 'now' };
const marked: ListingLike = { versions: [v('v1', '1'), v('v2', '2')], deleteMarkers: [{ versionId: 'dm', isLatest: true, lastModified: '2026-11-06T00:03:00Z' }], fetched_at: 'now' };
const one: ListingLike = { versions: [v('v1', '1', true)], deleteMarkers: [], fetched_at: 'now' };

describe('rewind', () => {
  it('two versions are reversible and one is the last copy', () => {
    expect(classifyDelete(two)).toMatchObject({ reversible: true, last_copy: false, versions: 2 });
    expect(classifyDelete(one)).toMatchObject({ reversible: false, last_copy: true });
  });
  it('after a delete marker the newest live version is restored', () => {
    expect(restoreTarget(marked)).toBe('v2');
    expect(classifyDelete(marked).has_delete_marker).toBe(true);
  });
  it('without a marker the previous version is the rewind target', () => {
    expect(restoreTarget(two)).toBe('v1');
    expect(restoreTarget(one)).toBeNull();
  });
  it('proof lines list versions and markers newest first and name the source', () => {
    const lines = proofLines(marked);
    expect(lines[0]).toContain('DELETE-MARKER dm');
    expect(lines.at(-1)).toContain('ListObjectVersions straight from S3');
  });
  it('restoredCorrectly demands content, no latest marker and a new version', () => {
    const after: ListingLike = { versions: [...marked.versions, v('v3', '4', true)], deleteMarkers: [], fetched_at: 'n' };
    expect(restoredCorrectly(marked, after, 'a', 'a').ok).toBe(true);
    expect(restoredCorrectly(marked, after, 'a', 'b').ok).toBe(false);
    expect(restoredCorrectly(marked, marked, 'a', 'a').ok).toBe(false);
  });
  it('restoredCorrectly refuses an extra version that is not the latest', () => {
    const stale: ListingLike = { versions: [...marked.versions, v('v3', '4', false)], deleteMarkers: [], fetched_at: 'n' };
    expect(restoredCorrectly(marked, stale, 'a', 'a').ok).toBe(false);
  });
  it('restoredCorrectly refuses a restore that left a latest marker', () => {
    const still: ListingLike = { versions: [...marked.versions, v('v3', '4')], deleteMarkers: marked.deleteMarkers, fetched_at: 'n' };
    expect(restoredCorrectly(marked, still, 'a', 'a')).toMatchObject({ ok: false });
  });
});
