import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';
import type { PluginConfigIssue } from '../config/config-schema.errors';
import type { PluginChangeKind } from '../manifest/manifest-move';
import { describeManifestMove } from '../manifest/manifest-move';

/**
 * Typed failures for the unit enablement surface (#323): the household
 * admin's enable/disable/config writes and the user's own enable/disable.
 * Domain errors, not HTTP exceptions — the API filter owns the status
 * mapping, the same discipline as the lifecycle, install, update, and
 * consent act errors.
 */

/** The actor is not an owner/admin member of the anchoring household. */
export class PluginUnitAuthorityError extends Error {
  override readonly name = 'PluginUnitAuthorityError';

  constructor(public readonly actorId: string) {
    super(`Actor '${actorId}' lacks authority: managing a household's plugin enablement requires a household admin`);
  }
}

/**
 * The addressed household is missing or soft-deleted (#548). Raised when the
 * household's share lock finds no live row inside the write's transaction, and
 * when the admin check refuses one of the household's own admins because it has
 * been deleted. The filter answers 404, the status the household routes give a
 * deleted household (#299, #553), to an actor those routes would tell, and
 * {@link PluginUnitAuthorityError}'s 403 to anyone else.
 */
export class PluginUnitHouseholdNotFoundError extends Error {
  override readonly name = 'PluginUnitHouseholdNotFoundError';

  constructor(public readonly householdId: string) {
    super(`Household '${householdId}' does not exist or has been deleted`);
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
 * too, so this surface never CREATES a row the rule says cannot exist and
 * never presents one as a real degraded unit.
 *
 * It does not retire one, either. A household→server version leaves every
 * household unit enablement for the plugin in place, and a unit whose plugin
 * scope has no household surface is dormant, worked out when read (#1151):
 * the unit enablement survives, so a re-scope back restores the household's
 * settings, and nothing serves it meanwhile. This error is what keeps the two
 * write paths that would have to invent a surface — enable and config PATCH —
 * from acting on such a unit.
 *
 * DISABLE is deliberately exempt (#369). A dormant unit is on the household
 * admin's screen with its dormancy reported, and refusing the only operation
 * that could act on it would leave them looking at a unit with no lever;
 * disabling records an intent about a unit enablement that already exists
 * rather than creating one.
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
 * No unit enablement exists for the addressed unit: the household or user
 * never switched the plugin on. The switch-on is a consent act and the only
 * creator of both unit enablements (#1150), so the unit lifecycle's
 * switch-off and config writes operate on existing rows and 404 otherwise.
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
 * The switch-on config gate (#323, #1151): a household switch-on that
 * supplies no configuration is refused when the document the unit would hold
 * (its retained one, or an empty one for a household with no unit
 * enablement) fails the active `config.schema`, with or without
 * `requiresHouseholdConfig`. `issues` lists the violations, so the client's
 * schema-driven form can render what to fix without a second request; it is
 * empty only for a first switch-on the manifest requires a document for.
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

/**
 * The plugin's active manifest was replaced between this request's
 * pre-transaction read and the plugin row's `FOR SHARE` lock, so every
 * manifest-derived judgment the request already made — the config schema it
 * validated against — describes a manifest that is no longer active.
 * Detected by comparing the manifest content under that lock, so a
 * replacement that leaves `version` and `installedAt` untouched is seen too
 * (#368).
 *
 * Refused rather than applied. A config document judged against the removed
 * schema lands in the stale-retained state the write path already heals,
 * but the guard covers it anyway rather than resting on a coincidence two
 * versions of this code apart (#323 review).
 *
 * Retryable, and immediately: whatever replaced the manifest has committed
 * by the time this is raised.
 */
export class PluginUnitPluginChangedError extends Error {
  override readonly name = 'PluginUnitPluginChangedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly kind: PluginChangeKind,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(describeManifestMove(pluginSlug, kind, expectedVersion, actualVersion));
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
