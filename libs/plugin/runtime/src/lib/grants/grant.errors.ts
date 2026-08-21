import type { PluginGrantScope } from '@bge/database';
import type { ManifestIssue } from '@boardgamesempire/plugin-manifest';

/**
 * Typed failures for the consent write path (#59 Phase C1). Domain errors,
 * not HTTP exceptions — the C4 consent endpoints own the mapping to status
 * codes, keeping this lib transport-agnostic like the loader errors.
 */

/**
 * The stored manifest failed consent-time re-validation, or its slug or
 * version drifted from the `Plugin` row — corrupted server state, never a
 * caller error. Carries the validation issues (when present) so the C4
 * surface can render them.
 */
export class PluginGrantManifestInvalidError extends Error {
  override readonly name = 'PluginGrantManifestInvalidError';

  constructor(
    public readonly pluginSlug: string,
    detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`Stored manifest for plugin '${pluginSlug}' is invalid: ${detail}`);
  }
}

/** The plugin the decision targets does not exist. Slug-addressed like every other endpoint-facing service (D-BO). */
export class PluginGrantPluginNotFoundError extends Error {
  override readonly name = 'PluginGrantPluginNotFoundError';

  constructor(public readonly pluginSlug: string) {
    super(`Plugin '${pluginSlug}' not found`);
  }
}

/**
 * D-AV (#59/#322): a `Denied` decision on a check the ACTIVE manifest marks
 * `required` at server consent scope. Refused rather than recorded — the
 * author declared the permission load-bearing, so accepting the denial
 * would either invent a fourth serving state or leave the plugin silently
 * running without it. The honest levers are first-class actions the same
 * decider already holds: disable or uninstall the plugin. A permission
 * required only by a PENDING manifest is deliberately NOT this error —
 * denying it stays legal and blocks at approve instead (D-AB); rejecting
 * the staged update is the explicit resolution.
 */
export class PluginGrantRequiredDenialError extends Error {
  override readonly name = 'PluginGrantRequiredDenialError';

  constructor(
    public readonly pluginSlug: string,
    public readonly permissionSlug: string,
  ) {
    super(
      `Cannot deny '${permissionSlug}' for plugin '${pluginSlug}': the active manifest requires it at server ` +
        'consent scope. Disable or uninstall the plugin instead',
    );
  }
}

/**
 * The plugin the decision targets is tombstoned: an uninstalled
 * plugin is not a decision target at ANY scope — its grants were cleared on
 * uninstall, and recording new consent against a row the loader will never
 * serve would manufacture authority for nothing (#225).
 */
export class PluginGrantPluginTombstonedError extends Error {
  override readonly name = 'PluginGrantPluginTombstonedError';

  constructor(
    public readonly pluginSlug: string,
    public readonly uninstalledAt: Date,
  ) {
    super(
      `Plugin '${pluginSlug}' was uninstalled at ${uninstalledAt.toISOString()} and cannot accept consent decisions`,
    );
  }
}

/**
 * The permission cannot be decided for this plugin: not requested by its
 * manifest, or (fail-loud) missing its backing catalog row.
 */
export class PluginGrantUnknownPermissionError extends Error {
  override readonly name = 'PluginGrantUnknownPermissionError';

  constructor(
    public readonly pluginSlug: string,
    public readonly permissionSlug: string,
    detail: string,
  ) {
    super(`Cannot decide '${permissionSlug}' for plugin '${pluginSlug}': ${detail}`);
  }
}

/** The decision's scope does not match the check's manifest-declared consentScope. */
export class PluginGrantConsentScopeMismatchError extends Error {
  override readonly name = 'PluginGrantConsentScopeMismatchError';

  constructor(
    public readonly permissionSlug: string,
    public readonly expected: PluginGrantScope,
    public readonly received: PluginGrantScope,
  ) {
    super(`'${permissionSlug}' is consented at ${expected} scope; received a ${received}-scope decision`);
  }
}

/** scopeId shape violation: present on Server, or missing on Household/User. Raised by decisions and revocations alike. */
export class PluginGrantScopeIdError extends Error {
  override readonly name = 'PluginGrantScopeIdError';

  constructor(
    public readonly scopeType: PluginGrantScope,
    detail: string,
  ) {
    super(`Invalid scopeId for ${scopeType} scope: ${detail}`);
  }
}

/**
 * The addressed scope has no authority-revocation semantics at all — Server
 * grants live and die with the plugin row. Distinct from
 * `PluginGrantScopeIdError`: the scopeId is not the problem, the scopeType
 * is, and this is not a decision path.
 */
export class PluginGrantScopeNotRevocableError extends Error {
  override readonly name = 'PluginGrantScopeNotRevocableError';

  constructor(public readonly scopeType: PluginGrantScope) {
    super(`${scopeType}-scope grants are not authority-revocable; they are removed with the plugin row`);
  }
}

/** The decider does not hold the authority being delegated. */
export class PluginGrantAuthorityError extends Error {
  override readonly name = 'PluginGrantAuthorityError';

  constructor(
    public readonly deciderId: string,
    detail: string,
  ) {
    super(`Decider '${deciderId}' lacks authority for this decision: ${detail}`);
  }
}

/** The permission is categorically ungrantable to plugin principals: an administration slug or a wildcard subject. */
export class PluginGrantExclusionError extends Error {
  override readonly name = 'PluginGrantExclusionError';

  constructor(
    public readonly permissionSlug: string,
    detail: string,
  ) {
    super(`'${permissionSlug}' can never be granted to a plugin: ${detail}`);
  }
}
