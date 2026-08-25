import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';

/**
 * No plugin under the requested slug (#354). The list reads never raise
 * this — an empty page is a legitimate answer to "what is installed" —
 * so it belongs solely to the single-plugin read, which owes the 404/410
 * distinction the same way every other slug-addressed C4 read does.
 */
export class PluginInventoryNotFoundError extends Error {
  override readonly name = 'PluginInventoryNotFoundError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' not found`);
  }
}

/**
 * The requested plugin is tombstoned (#354, D-CH). Deliberately
 * unconditional: the list takes an opt-in flag to include tombstones, and
 * the single read does NOT get the same flag. A tombstone is a resource
 * that WAS there and 410 says exactly that — letting a query parameter turn
 * it into a 200 would make one route answer two statuses for identical
 * state, which no client can dispatch on.
 */
export class PluginInventoryTombstonedError extends Error {
  override readonly name = 'PluginInventoryTombstonedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(`Plugin '${pluginSlug}' was uninstalled at ${uninstalledAt.toISOString()}`);
  }
}

/**
 * A stored `Plugin.manifestJson` that fails re-validation while rendering
 * the SINGLE-plugin read (#354, D-CG). Raised only there: the list reads
 * degrade the offending row instead, because one corrupt manifest must not
 * take out the management screen an admin would use to uninstall it, while
 * a single-plugin read has no other subject and nothing honest to return.
 *
 * Same never-trust-a-stored-manifest contract as its siblings
 * (`PluginFeatureStateManifestError`, `PluginGrantManifestInvalidError`),
 * typed per surface so the C4 boundary can map it without casting.
 */
export class PluginInventoryManifestError extends Error {
  override readonly name = 'PluginInventoryManifestError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Cannot render plugin '${pluginSlug}': ${detail}`);
  }
}
