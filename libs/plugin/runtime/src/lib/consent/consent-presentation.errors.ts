import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';

/**
 * A stored `Plugin` manifest that fails re-validation — or disagrees with
 * the row's slug/version — while assembling a consent presentation. The same
 * never-trust-a-stored-manifest contract as the grant write path and
 * feature-state (`revalidateStoredManifest`), typed per surface so the C4
 * boundary can map it and render the issues without casting.
 */
export class PluginConsentPresentationManifestError extends Error {
  override readonly name = 'PluginConsentPresentationManifestError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Cannot present the consent surface for plugin '${pluginSlug}': ${detail}`);
  }
}
