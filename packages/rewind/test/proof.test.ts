import { describe, expect, it } from 'vitest';
import { classifyDelete, objectVersionCount, runRewindProof, type ListingLike, type RewindProofPort } from '../src/index.ts';

const ver = (id: string, t: number, latest = false) => ({ versionId: id, isLatest: latest, size: 9, lastModified: new Date(Date.UTC(2026, 10, 6, 0, t)).toISOString() });

/** In-memory versioned bucket that behaves like S3: delete adds a marker, restore copies a version into a NEW latest version. */
function fakeBucket(initial = 2, opts: { denyDelete?: boolean; brokenRestore?: boolean } = {}): RewindProofPort & { listing: ListingLike } {
  let t = initial;
  let seq = initial;
  const state = {
    bodies: new Map<string, string>(),
    listing: { versions: [] as ReturnType<typeof ver>[], deleteMarkers: [] as { versionId: string; isLatest: boolean; lastModified: string }[], fetched_at: 'now' },
  };
  for (let i = 1; i <= initial; i += 1) {
    state.listing.versions.push(ver(`v${i}`, i, i === initial));
    state.bodies.set(`v${i}`, `body-${i}`);
  }
  const latestBody = () => (state.listing.deleteMarkers.some((m) => m.isLatest) ? '' : state.bodies.get(state.listing.versions.find((v) => v.isLatest)?.versionId ?? '') ?? '');
  return {
    get listing() { return JSON.parse(JSON.stringify(state.listing)) as ListingLike; },
    list: async () => JSON.parse(JSON.stringify(state.listing)) as ListingLike,
    read: async () => latestBody(),
    now: () => (t += 7) * 1000,
    del: async () => {
      if (opts.denyDelete) return { allowed: false };
      state.listing.versions.forEach((v) => { v.isLatest = false; });
      t += 1;
      state.listing.deleteMarkers.push({ versionId: `dm${t}`, isLatest: true, lastModified: new Date(Date.UTC(2026, 10, 6, 0, t)).toISOString() });
      return { allowed: true };
    },
    restore: async (id) => {
      if (opts.brokenRestore) return { allowed: true };
      state.listing.deleteMarkers = [];
      state.listing.versions.forEach((v) => { v.isLatest = false; });
      seq += 1;
      t += 1;
      const nid = `v${seq}`;
      state.listing.versions.push(ver(nid, t, true));
      state.bodies.set(nid, state.bodies.get(id) ?? '');
      return { allowed: true };
    },
  };
}

describe('runRewindProof (GATE-L6 logic against a faithful in-memory bucket)', () => {
  it('delete -> marker -> restore -> new version proves all six booleans', async () => {
    const p = await runRewindProof(fakeBucket(2));
    expect(p).toMatchObject({ two_versions_before: true, delete_allowed: true, marker_after_delete: true, restore_allowed: true, no_latest_marker_after: true, new_version_written: true });
    expect(p.restore_round_trip_ms).toBeGreaterThan(0);
    expect(p.version_ids).toContain('v3');
  });
  it('a bucket with one version fails at step one and never deletes', async () => {
    const b = fakeBucket(1);
    const p = await runRewindProof(b);
    expect(p.two_versions_before).toBe(false);
    expect(p.delete_allowed).toBe(false);
    expect(b.listing.deleteMarkers).toHaveLength(0);
  });
  it('a refused delete leaves every later boolean false', async () => {
    const p = await runRewindProof(fakeBucket(2, { denyDelete: true }));
    expect(p).toMatchObject({ two_versions_before: true, delete_allowed: false, marker_after_delete: false, restore_allowed: false, new_version_written: false });
  });
  it('a restore that writes nothing is not reported as a pass', async () => {
    const p = await runRewindProof(fakeBucket(2, { brokenRestore: true }));
    expect(p.restore_allowed).toBe(true);
    expect(p.no_latest_marker_after).toBe(false);
    expect(p.new_version_written).toBe(false);
  });
});

describe('unknown object state fails closed', () => {
  it('a missing or malformed listing has no version count and is not reversible', () => {
    expect(objectVersionCount(null)).toBeNull();
    expect(objectVersionCount({} as ListingLike)).toBeNull();
    expect(classifyDelete(null)).toMatchObject({ state_known: false, reversible: false, last_copy: false });
    expect(classifyDelete(undefined)).toMatchObject({ state_known: false });
  });
  it('a real listing has a count', () => {
    const l: ListingLike = { versions: [ver('a', 1, true)], deleteMarkers: [], fetched_at: 'n' };
    expect(objectVersionCount(l)).toBe(1);
    expect(classifyDelete(l)).toMatchObject({ state_known: true, last_copy: true });
  });
});
