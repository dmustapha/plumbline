import { restoredCorrectly, restoreTarget, type ListingLike } from './rewind.ts';

/** What the GATE-L6 runner provides. `list`/`read` must hit S3 directly (independent credentials), never UI or broker state. */
export interface RewindProofPort {
  list(): Promise<ListingLike>;
  read(): Promise<string>;
  del(): Promise<{ allowed: boolean }>;
  restore(versionId: string): Promise<{ allowed: boolean }>;
  now(): number;
}

export interface RewindProof {
  two_versions_before: boolean;
  delete_allowed: boolean;
  marker_after_delete: boolean;
  restore_allowed: boolean;
  no_latest_marker_after: boolean;
  new_version_written: boolean;
  restore_round_trip_ms: number;
  version_ids: string[];
  detail: string;
}

const emptyProof = (detail: string): RewindProof => ({
  two_versions_before: false, delete_allowed: false, marker_after_delete: false, restore_allowed: false,
  no_latest_marker_after: false, new_version_written: false, restore_round_trip_ms: 0, version_ids: [], detail,
});

/**
 * Reads the object first: the restored copy must equal what the object held before the delete.
 * delete -> marker -> restore -> new version, every boolean read from a fresh listing. Stops at the first failed step,
 * so a later boolean is never true on the strength of an earlier failure.
 */
export async function runRewindProof(port: RewindProofPort): Promise<RewindProof> {
  const before = await port.list();
  const out = emptyProof('two versions were not present before the delete');
  out.two_versions_before = before.versions.length >= 2;
  if (!out.two_versions_before) return out;
  const expected = await port.read();
  out.delete_allowed = (await port.del()).allowed;
  if (!out.delete_allowed) return { ...out, detail: 'the engine did not allow the delete' };
  const marked = await port.list();
  out.marker_after_delete = marked.deleteMarkers.some((m) => m.isLatest);
  const target = restoreTarget(marked);
  if (!out.marker_after_delete || !target) return { ...out, detail: 'no latest delete marker after the delete' };
  const started = port.now();
  out.restore_allowed = (await port.restore(target)).allowed;
  if (!out.restore_allowed) return { ...out, detail: 'the engine did not allow the restore' };
  const after = await port.list();
  out.restore_round_trip_ms = port.now() - started;
  out.no_latest_marker_after = !after.deleteMarkers.some((m) => m.isLatest);
  const check = restoredCorrectly(marked, after, expected, await port.read());
  out.new_version_written = out.no_latest_marker_after && check.ok;
  out.version_ids = [...after.versions.map((v) => v.versionId), ...after.deleteMarkers.map((m) => m.versionId)];
  return { ...out, detail: check.detail };
}
