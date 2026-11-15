import { bindsConsentUnit, PluginGrantScope, type Permission } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckDecisionInput } from './plugin-consent-check-classifier.service';

/** The catalog columns the shared rule reads off a core permission row. */
export type ConsentCatalogPermission = Pick<
  Permission,
  'slug' | 'action' | 'subject' | 'fields' | 'conditions' | 'inverted'
>;

/**
 * The two catalog-derived inputs of the rule, read the same way wherever the
 * rule runs. A core subject drifted to the `all` wildcard: grant-time forbids
 * wildcard subjects (#59), so such a grant confers nothing at consumption. A
 * core permission consented at household or user scope confers nothing unless
 * it binds the consenting unit (#60, #591), mirroring the ability read path;
 * server-consented checks are exempt.
 */
export function consentCatalogFlags(input: {
  readonly origin: NormalizedPermissionRequest['origin'];
  readonly decidingScope: PluginGrantScope;
  readonly corePermission: ConsentCatalogPermission | undefined;
}): Pick<ConsentCheckDecisionInput, 'wildcardSubject' | 'unboundedUnitScope'> {
  const { origin, decidingScope, corePermission } = input;

  return {
    wildcardSubject: origin === 'core' && corePermission?.subject === 'all',
    unboundedUnitScope:
      origin === 'core' &&
      decidingScope !== PluginGrantScope.Server &&
      corePermission !== undefined &&
      !bindsConsentUnit(corePermission, decidingScope),
  };
}
