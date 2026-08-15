import {
  PluginManifestValidationError,
  validatePluginManifest,
  type ManifestIssue,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';

/**
 * The `Plugin` columns the re-validation cross-checks — pass `pendingVersion`/`pendingManifestJson` to validate a staged manifest.
 */
export interface StoredManifestRow {
  readonly slug: string;
  readonly version: string;
  readonly manifestJson: unknown;
}

/**
 * Builds the surface's typed error for an invalid stored manifest. Each
 * consumer keeps its own error class so the C4 boundary can map per domain
 * (`PluginGrantManifestInvalidError`, `PluginFeatureStateManifestError`,
 * `PluginConsentPresentationManifestError`) — what is shared is the
 * validation contract, not the error identity.
 */
export type StoredManifestInvalidFactory = (
  pluginSlug: string,
  detail: string,
  issues?: readonly ManifestIssue[],
) => Error;

/**
 * The never-trust-a-stored-manifest contract, shared by every surface that
 * re-reads `Plugin.manifestJson` at consumption time (the grant write path,
 * feature-state derivation, consent presentation — extracted when the third
 * copy was about to become a fourth):
 *
 * - The JSON is re-validated on every read, never trusted because it
 *   validated once — an invalid stored manifest is corrupted server state.
 * - `enforceBgeCompat: false`: whether the plugin can LOAD under the current
 *   BGE is irrelevant to reading or deciding consent about it; a BGE upgrade
 *   past the plugin's range must not make its consent state unreadable.
 * - The manifest's slug must agree with the row: canonical permission slugs
 *   are expanded from the manifest, so on drift they would resolve against
 *   ANOTHER plugin's catalog — the cross-namespace confusion the namespacing
 *   exists to prevent.
 * - The manifest's version must agree with the row: grant rows are stamped
 *   with the column while the checks come from the JSON, so drift makes
 *   every risk/escalation comparison meaningless.
 *
 * The update service deliberately does NOT ride this helper: it validates
 *  from multiple sources (incoming file, active column, pending column) with
 * `bgeCompat` enforcement that varies by seam, which is a different contract
 * wearing similar clothes.
 *
 * Tombstone checks stay with the caller — this helper is reachable both from
 * paths that refuse tombstoned rows (`decide`) and paths that must
 * short-circuit BEFORE validation so a stale manifest cannot turn
 * "uninstalled" into a 5xx (feature-state, presentation).
 */
export const revalidateStoredManifest = (
  row: StoredManifestRow,
  options: Pick<PluginModuleOptions, 'bgeVersion' | 'defaultLocale'>,
  invalid: StoredManifestInvalidFactory,
): PluginManifestValidationResult => {
  let validated: PluginManifestValidationResult;

  try {
    validated = validatePluginManifest(row.manifestJson, {
      bgeVersion: options.bgeVersion,
      defaultLocale: options.defaultLocale,
      enforceBgeCompat: false,
    });
  } catch (err) {
    if (err instanceof PluginManifestValidationError) {
      throw invalid(row.slug, 'stored manifest failed re-validation', err.issues);
    }

    throw err;
  }

  if (validated.manifest.slug !== row.slug) {
    throw invalid(
      row.slug,
      `manifest slug '${validated.manifest.slug}' does not match the plugin row — ` +
        "canonical permission slugs would resolve against another plugin's catalog",
    );
  }

  if (validated.manifest.version !== row.version) {
    throw invalid(
      row.slug,
      `manifest version '${validated.manifest.version}' does not match the plugin row's '${row.version}' — ` +
        'the row is stamped with the column while the checks come from the JSON, so the two must agree',
    );
  }

  return validated;
};
