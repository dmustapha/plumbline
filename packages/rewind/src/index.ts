// File: packages/rewind/src/index.ts
export { classifyDelete, objectVersionCount, restoreTarget, proofLines, restoredCorrectly } from './rewind.ts';
export type { ListingLike, Classification } from './rewind.ts';
export { assertSessionKey, canaryContent, ensureCanaryVersions, sessionCanaryKey, sessionKeyGuard } from './session-keys.ts';
export type { CanaryPort } from './session-keys.ts';
export { runRewindProof } from './proof.ts';
export type { RewindProof, RewindProofPort } from './proof.ts';
