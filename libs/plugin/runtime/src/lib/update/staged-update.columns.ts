import { Prisma } from '@bge/database';

/**
 * The staged-update columns in their cleared state.
 *
 * Four writers end a staged update — activation promotes it, rejection
 * discards it, uninstall tombstones over it, and reinstall refuses to let one
 * resurrect — and the cleared SET is itself a signal: #84's ingress pipeline
 * reads it as "the staged files are now garbage". A site that clears three of
 * the four columns leaves a half-staged row that reads as neither pending nor
 * clean, so the set lives here rather than being retyped per writer.
 */
export const CLEARED_STAGED_UPDATE = {
  pendingVersion: null,
  pendingManifestJson: Prisma.DbNull,
  pendingSha256: null,
  pendingSince: null,
};
