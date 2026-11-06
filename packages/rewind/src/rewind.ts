// File: packages/rewind/src/rewind.ts
export interface ListingLike {
  versions: { versionId: string; isLatest: boolean; size: number; lastModified: string }[];
  deleteMarkers: { versionId: string; isLatest: boolean; lastModified: string }[];
  fetched_at: string;
}

export interface Classification {
  reversible: boolean;
  last_copy: boolean;
  /** false when the version count cannot be trusted: the engine then DENYs with object-state-unknown (fail closed). */
  state_known: boolean;
  versions: number;
  has_delete_marker: boolean;
}

const newestFirst = <T extends { lastModified: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0));

const wellFormed = (l: ListingLike | null | undefined): l is ListingLike =>
  Boolean(l) && Array.isArray(l?.versions) && Array.isArray(l?.deleteMarkers);

/** The count the engine judges on: null (unknown) for a missing or malformed listing, never a guessed number. */
export function objectVersionCount(l: ListingLike | null | undefined): number | null {
  return wellFormed(l) ? l.versions.length : null;
}

export function classifyDelete(l: ListingLike | null | undefined): Classification {
  if (!wellFormed(l)) return { reversible: false, last_copy: false, state_known: false, versions: 0, has_delete_marker: false };
  const versions = l.versions.length;
  return { reversible: versions >= 2, last_copy: versions <= 1, state_known: true, versions, has_delete_marker: l.deleteMarkers.some((m) => m.isLatest) };
}

/** After a delete the marker is latest and the newest live version is the one to restore; otherwise rewind to the previous version. */
export function restoreTarget(l: ListingLike): string | null {
  const live = newestFirst(l.versions);
  const markerLatest = l.deleteMarkers.some((m) => m.isLatest);
  const pick = markerLatest ? live[0] : live[1];
  return pick ? pick.versionId : null;
}

export function proofLines(l: ListingLike): string[] {
  const rows = [
    ...l.versions.map((v) => ({ t: v.lastModified, text: `VERSION ${v.versionId}${v.isLatest ? ' (latest)' : ''} ${v.size} bytes ${v.lastModified}` })),
    ...l.deleteMarkers.map((m) => ({ t: m.lastModified, text: `DELETE-MARKER ${m.versionId}${m.isLatest ? ' (latest)' : ''} ${m.lastModified}` })),
  ];
  const lines = rows.sort((a, b) => (a.t < b.t ? 1 : -1)).map((r) => r.text);
  lines.push(`source: ListObjectVersions straight from S3, fetched ${l.fetched_at}`);
  return lines;
}

export function restoredCorrectly(before: ListingLike, after: ListingLike, expectedContent: string, actualContent: string): { ok: boolean; detail: string } {
  if (actualContent !== expectedContent) return { ok: false, detail: 'content after rewind differs from the restored version' };
  if (after.deleteMarkers.some((m) => m.isLatest)) return { ok: false, detail: 'a delete marker is still the latest entry' };
  const known = new Set(before.versions.map((v) => v.versionId));
  const latest = after.versions.find((v) => v.isLatest);
  if (after.versions.length <= before.versions.length || !latest || known.has(latest.versionId)) return { ok: false, detail: 'no new version was written by the restore' };
  return { ok: true, detail: 'latest version equals the restored content' };
}
