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

/**
 * No plugin under the requested slug (D-BO, #322). The id-addressed
 * presentation paths return `null` for their in-process composers; the
 * slug-addressed entry point serves the HTTP edge, which owes D-AY's
 * 404/410 distinction and cannot draw it from one `null`.
 */
export class PluginConsentPresentationNotFoundError extends Error {
  override readonly name = 'PluginConsentPresentationNotFoundError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' not found`);
  }
}

/**
 * The requested plugin is tombstoned (#322): its grants are purged and
 * `decide()` refuses new ones, so no consent surface exists — but the
 * record exists and says so, which is D-AY's 410, never a 404.
 */
export class PluginConsentPresentationTombstonedError extends Error {
  override readonly name = 'PluginConsentPresentationTombstonedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(`Plugin '${pluginSlug}' was uninstalled at ${uninstalledAt.toISOString()} and has no consent surface`);
  }
}
