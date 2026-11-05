import { Prisma } from '@bge/database';

/**
 * The staged-update columns in their cleared state.
 *
 * Four writers end a staged update — activation promotes it, rejection
 * discards it, uninstall clears it, and reinstall refuses to let one
 * resurrect — and all of them clear this one set. Afterwards the staged
 * artifact's directory is named only if activation made it the installed one
 * (`installedSha256`); otherwise no living row names it, and the planned
 * artifact sweep (#1094) is to remove it (#224). A site that clears only some
 * of the columns leaves a
 * half-staged row that reads as neither pending nor clean, so the set lives
 * here rather than being retyped per writer.
 */
export const CLEARED_STAGED_UPDATE = {
  pendingVersion: null,
  pendingManifestJson: Prisma.DbNull,
  pendingSha256: null,
  pendingSince: null,
  pendingStagingId: null,
};
