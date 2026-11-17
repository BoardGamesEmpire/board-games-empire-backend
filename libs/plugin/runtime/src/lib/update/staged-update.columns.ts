import { Prisma } from '@bge/database';

/**
 * The staged-update columns in their cleared state.
 *
 * Four writers end a staged update — activation promotes it, rejection
 * discards it, uninstall clears it, and reinstall refuses to let one
 * resurrect — and all of them clear this one set. Afterwards the staged
 * artifact's directory is named only if activation made it the installed one
 * (`installedSha256`); otherwise no living row names it, and the plugin
 * artifact sweep (#1094) removes it (#224). The sweep keeps a directory the
 * running server loaded a plugin from, too: after activation or uninstall,
 * no row names the old directory, but the old code runs from it until the
 * restart `restartRequired` asks for. The set also holds the staged
 * artifact's provenance, its link and registry (#1096), which the CHECK
 * `plugins_staged_provenance_needs_staging` allows only while an update is
 * staged. A site that clears only some of the columns leaves a half-staged
 * row that reads as neither staged nor clean, so the set lives here rather
 * than being retyped per writer.
 */
export const CLEARED_STAGED_UPDATE = {
  pendingVersion: null,
  pendingManifestJson: Prisma.DbNull,
  pendingSha256: null,
  pendingSince: null,
  pendingStagingId: null,
  pendingFromUrl: null,
  pendingRegistrySlug: null,
};
