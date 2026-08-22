import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import type { PluginConfigIssue } from '../config/config-schema.errors';

/**
 * Typed failures for the unit enablement surface (#323): the household
 * admin's enable/disable/config writes and the user's own enable/disable.
 * Domain errors, not HTTP exceptions — the API filter owns the status
 * mapping, the same discipline as the lifecycle, install, update, and
 * grant errors.
 */

/** The actor is not an owner/admin member of the anchoring household. */
export class PluginUnitAuthorityError extends Error {
  override readonly name = 'PluginUnitAuthorityError';

  constructor(public readonly actorId: string) {
    super(`Actor '${actorId}' lacks authority: managing a household's plugin enablement requires a household admin`);
  }
}

/** No `Plugin` row exists for the slug. */
export class PluginUnitPluginNotFoundError extends Error {
  override readonly name = 'PluginUnitPluginNotFoundError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' is not installed`);
  }
}

/** The plugin row is a tombstone: uninstalled code has no enablement surface to manage. */
export class PluginUnitPluginTombstonedError extends Error {
  override readonly name = 'PluginUnitPluginTombstonedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(`Plugin '${pluginSlug}' was uninstalled at ${uninstalledAt.toISOString()} and has no unit enablement`);
  }
}

/**
 * The HOUSEHOLD surface was addressed for a `scope: 'server'` plugin. The
 * manifest gate's scope-coherence rule — a server-scope plugin has no
 * `HouseholdPlugin` enable/config surface, so household-scope consent has
 * no collection point — enforced at the writers and at the feature read
 * too, so no meaningless unit rows accumulate and the read never presents
 * impossible unit state as a real degraded unit.
 *
 * The user axis is NOT covered by this rule: `UserPlugin` is a real
 * surface at any plugin scope (#225), so this error never describes it.
 */
export class PluginUnitScopeError extends Error {
  override readonly name = 'PluginUnitScopeError';

  constructor(
    public readonly pluginSlug: string,
    public readonly scope: string,
  ) {
    super(`Plugin '${pluginSlug}' is ${scope}-scoped and has no per-household enablement surface`);
  }
}

/**
 * No enablement row exists for the addressed unit. For households that
 * means the plugin was never enabled there (enable is the row creator);
 * for users it means no user-scope consent was ever granted —
 * `decide()` remains the only creator of `UserPlugin` rows (#225), so
 * enable/disable here operate on existing rows and 404 otherwise.
 */
export class PluginUnitNotEnrolledError extends Error {
  override readonly name = 'PluginUnitNotEnrolledError';

  constructor(
    public readonly pluginSlug: string,
    public readonly scopeType: 'Household' | 'User',
  ) {
    super(`Plugin '${pluginSlug}' has no ${scopeType.toLowerCase()} enablement row for this unit`);
  }
}

/**
 * The enable-time config gate (#323): the active manifest declares
 * `requiresHouseholdConfig` and neither the enable request nor a retained
 * row supplied a config document satisfying `config.schema`. `issues`
 * carries the retained document's violations when one existed (a stale
 * config left by an update or reinstall) — empty when there was nothing
 * to validate — so the client's schema-driven form can render what to fix
 * without a second request.
 */
export class PluginUnitConfigRequiredError extends Error {
  override readonly name = 'PluginUnitConfigRequiredError';

  constructor(
    public readonly pluginSlug: string,
    public readonly issues: readonly PluginConfigIssue[],
  ) {
    super(`Plugin '${pluginSlug}' requires household configuration before it can be enabled`);
  }
}

/** The stored active manifest failed re-validation on a unit write path — corrupted server state, never a caller error. */
export class PluginUnitManifestError extends Error {
  override readonly name = 'PluginUnitManifestError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Stored manifest for plugin '${pluginSlug}' is invalid: ${detail}`);
  }
}
