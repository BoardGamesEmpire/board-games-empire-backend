import type { Permission } from '@bge/database';
import { bindsConsentUnit, isAttendanceOnly, PluginGrantScope } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckDecisionInput } from './plugin-consent-check-classifier.service';

/** The catalog columns the shared rule reads off a core permission row. */
export type ConsentCatalogPermission = Pick<
  Permission,
  'slug' | 'action' | 'subject' | 'fields' | 'conditions' | 'inverted'
>;

/**
 * The three catalog-derived inputs of the rule, read the same way wherever
 * the rule runs. A core subject drifted to the `all` wildcard: grant-time
 * forbids wildcard subjects (#59), so such a grant confers nothing at
 * consumption. A core permission on an attendance-only resource type confers
 * nothing either: a plugin's ability denies those types after every allow
 * (#1543). A core permission consented at household or user scope confers
 * nothing unless it binds the consenting unit (#60, #591), mirroring the
 * ability read path; server-consented checks are exempt.
 */
export function consentCatalogFlags(input: {
  readonly corePermission: ConsentCatalogPermission | undefined;
  readonly decidingScope: PluginGrantScope;
  readonly origin: NormalizedPermissionRequest['origin'];
}): Pick<ConsentCheckDecisionInput, 'attendanceOnlySubject' | 'unboundedUnitScope' | 'wildcardSubject'> {
  const { origin, decidingScope, corePermission } = input;

  return {
    wildcardSubject: origin === 'core' && corePermission?.subject === 'all',
    attendanceOnlySubject:
      origin === 'core' && corePermission !== undefined && isAttendanceOnly(corePermission.subject),
    unboundedUnitScope:
      origin === 'core' &&
      decidingScope !== PluginGrantScope.Server &&
      corePermission !== undefined &&
      !bindsConsentUnit(corePermission, decidingScope),
  };
}
