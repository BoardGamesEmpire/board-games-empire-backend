import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';

/**
 * A stored `Plugin.manifestJson` that fails re-validation — or disagrees
 * with the row's slug/version — while resolving feature state. The same
 * never-trust-a-stored-manifest contract the grant write path enforces
 * (`PluginGrantManifestInvalidError`), typed per surface so the C4 boundary
 * can map it and render the issues without casting.
 */
export class PluginFeatureStateManifestError extends Error {
  override readonly name = 'PluginFeatureStateManifestError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Cannot resolve feature state for plugin '${pluginSlug}': ${detail}`);
  }
}

/**
 * No plugin under the requested slug (#323). The id-addressed
 * `resolveForUnit` returns `null` for its in-process composers; the
 * slug-addressed entry point serves the HTTP edge, which owes the
 * 404/410 distinction and cannot draw it from one `null` — the same split
 * the consent presentation drew for its slug addressing (#322).
 */
export class PluginFeatureStateNotFoundError extends Error {
  override readonly name = 'PluginFeatureStateNotFoundError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' not found`);
  }
}

/**
 * The requested plugin is tombstoned (#323): its grants and catalog are
 * purged, so no feature state exists to explain — but the record exists
 * and says so, which is a 410, never a 404. The id-addressed read
 * instead SHORT-CIRCUITS tombstones to a served-false state, which is the
 * right answer for an in-process composer and the wrong one for an edge
 * that must not conflate "uninstalled" with a degraded unit.
 */
export class PluginFeatureStateTombstonedError extends Error {
  override readonly name = 'PluginFeatureStateTombstonedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(`Plugin '${pluginSlug}' was uninstalled at ${uninstalledAt.toISOString()} and has no feature state`);
  }
}
