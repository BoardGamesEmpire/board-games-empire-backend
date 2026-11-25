import { major } from 'semver';
import type { PluginConsentScopeValue } from './constants.js';
import type { ManifestWarning } from './errors.js';
import { ManifestWarningCode } from './errors.js';
import type { NormalizedPermissionRequest, PluginManifestValidationResult } from './manifest.types.js';

const UNIT_SCOPES: readonly PluginConsentScopeValue[] = ['household', 'user'];

const isRequiredAtUnitScope = (check: NormalizedPermissionRequest): boolean =>
  check.required && UNIT_SCOPES.includes(check.consentScope);

/**
 * Compares two manifests' consent requirements the way a server does when an
 * update arrives (#1093): a required check at household or user scope that the
 * previous manifest did not already require at that same scope is an
 * escalation, because each household or user that has not consented to it goes
 * to review pending (#59). Checks are keyed by canonical slug, so a renamed own
 * permission counts as new. Removed checks, new optional checks and new
 * required server-scope checks never warn.
 *
 * The message says whether `next` bumped the major version, so a plugin author
 * sees at once whether the version already signals the escalation.
 */
export const compareUnitConsentRequirements = (
  previous: PluginManifestValidationResult,
  next: PluginManifestValidationResult,
): readonly ManifestWarning[] => {
  const previousRequiredScopes = new Map<string, PluginConsentScopeValue>();

  for (const check of previous.permissionChecks) {
    if (check.required) {
      previousRequiredScopes.set(check.canonicalSlug, check.consentScope);
    }
  }

  const majorBumped = major(next.manifest.version) > major(previous.manifest.version);
  const warnings: ManifestWarning[] = [];

  next.permissionChecks.forEach((check, index) => {
    if (!isRequiredAtUnitScope(check) || previousRequiredScopes.get(check.canonicalSlug) === check.consentScope) {
      return;
    }

    warnings.push({
      code: ManifestWarningCode.REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED,
      path: `permissions.checks[${index}]`,
      message:
        `'${check.canonicalSlug}' is newly required at '${check.consentScope}' consent scope. This is an escalation: ` +
        'each household or user that has not consented to it goes to review pending, and the plugin runs for them ' +
        'without it until they consent. ' +
        (majorBumped
          ? 'The major version was bumped, which signals the change.'
          : 'The major version was not bumped; a change like this belongs in a major release.'),
    });
  });

  return warnings;
};
