import type { PluginManifestValidationResult } from './manifest.types.js';
import { isPluginAdministrationSlug } from './plugin-admin-permissions.js';
import { parsePluginPermissionSlug } from './plugin-permission-slug.js';

export interface ForbiddenPermissionViolation {
  readonly detail: string;
  readonly permissionSlug: string;
}

/**
 * Categorical exclusions on the manifest's permission surface (#59):
 * plugin-administration authority requested as a core check, a declared
 * bare slug that mimics the administration vocabulary, or a declared slug
 * claiming the `'all'` subject. Pattern-based on purpose — the refusal must
 * not depend on the C4 seed rows existing.
 */
export const collectForbiddenPermissionViolations = (
  validated: PluginManifestValidationResult,
): readonly ForbiddenPermissionViolation[] => {
  const violations: ForbiddenPermissionViolation[] = [];

  for (const check of validated.permissionChecks) {
    if (check.origin === 'core' && isPluginAdministrationSlug(check.canonicalSlug)) {
      violations.push({
        permissionSlug: check.canonicalSlug,
        detail: 'is plugin-administration authority — granted to a plugin it is a self-escalation loop',
      });
    }
  }

  for (const declared of validated.declaredPermissions) {
    const parsed = parsePluginPermissionSlug(declared.canonicalSlug);

    if (isPluginAdministrationSlug(parsed.bareSlug)) {
      violations.push({
        permissionSlug: declared.canonicalSlug,
        detail: 'mimics the plugin-administration vocabulary — the hard exclusion applies to the bare form',
      });
    }

    if (parsed.subjectPath === 'all' || parsed.subjectPath.startsWith('all:')) {
      violations.push({
        permissionSlug: declared.canonicalSlug,
        detail: "claims the 'all' subject — a naive CASL mapping would read it as wildcard authority",
      });
    }
  }

  return violations;
};
