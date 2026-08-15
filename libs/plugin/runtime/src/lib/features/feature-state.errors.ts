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
