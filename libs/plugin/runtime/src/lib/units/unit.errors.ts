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
 * too, so this surface never CREATES a row the rule says cannot exist and
 * never presents one as a real degraded unit.
 *
 * It does not retire one, either — activation does that. A household→server
 * version marks every row for the plugin DORMANT (#369, D-CK): the rows
 * survive, so a re-scope back restores the household's settings, and nothing
 * serves them meanwhile. This error is what keeps the two write paths that
 * would have to invent a surface — enable and config PATCH — from acting on
 * such a row.
 *
 * DISABLE is deliberately exempt (D-CL). A dormant row is on the household
 * admin's screen with its reason attached, and refusing the only operation that
 * could act on it would leave them looking at a unit with no lever; disabling
 * records an intent about a row that already exists rather than creating one.
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

/**
 * How the active manifest stopped being the one a request derived its
 * judgments from. Two writers can do it, and `version` alone cannot tell
 * them apart: activation promotes a new version in place and never touches
 * `installedAt`, while a reinstall over a tombstone replaces `manifestJson`
 * on the same row — same id, same slug — at whatever version it was handed,
 * so it may move the version too. `installedAt` is therefore what
 * classifies: only the installer writes it.
 *
 * The distinction reaches the client because the two differ in what
 * survived. A reinstall's uninstall purged every grant for the plugin, so
 * consent starts from zero; an activation kept them.
 */
export type PluginUnitChangeKind = 'version-activated' | 'reinstalled';

/**
 * The plugin's active manifest was replaced between this request's
 * pre-transaction read and the plugin row's `FOR SHARE` lock, so every
 * manifest-derived judgment the request already made — the config schema it
 * validated against, the required-check set the born-suspended probe
 * consulted — describes a manifest that is no longer active.
 *
 * Refused rather than applied. For an activation the stakes are concrete: a
 * stale probe can create a serving row beside a durable denial of a newly
 * required check (activation keeps the grants the probe reads), or suspend a
 * row over a check the new manifest no longer requires and no decision can
 * heal. A reinstall's stakes are lower — its uninstall purged the grants the
 * probe reads, so the probe cannot be misled, and a config document judged
 * against the removed schema lands in the stale-retained state the write
 * path already heals — but the guard covers it anyway rather than resting on
 * a coincidence two versions of this code apart (#323 review).
 *
 * Retryable, and immediately: whatever replaced the manifest has committed
 * by the time this is raised.
 */
export class PluginUnitPluginChangedError extends Error {
  override readonly name = 'PluginUnitPluginChangedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly kind: PluginUnitChangeKind,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(
      kind === 'version-activated'
        ? `Plugin '${pluginSlug}' was activated from version ${expectedVersion} to ${actualVersion} while this ` +
            `request was in flight; retry against the current manifest`
        : `Plugin '${pluginSlug}' was reinstalled at version ${actualVersion} while this request was in flight; ` +
            `retry against the current manifest`,
    );
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
