import type { PluginGrantScope, RiskLevel } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { consentCatalogFlags, type ConsentCatalogPermission } from '../consent/consent-catalog-flags';
import type { ConsentManifestSource } from '../consent/consent-classification.types';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';

/**
 * Why a requested permission can never be granted at all, whoever consents.
 * Not a consent decision: it is a property of the permission and the scope
 * that decides it (#1150).
 */
export type ConsentUngrantableCause =
  /** A core row that is retired or gone; or a declared row missing under the ACTIVE manifest. */
  | 'no_catalog_row'
  /** The core subject is `all`. */
  | 'wildcard_subject'
  /** Consented below server scope, but the permission does not bind the consenting unit (#591). */
  | 'unbound_unit_scope'
  /**
   * Plugin administration (core, or a declared permission whose bare slug
   * mimics it), or a declared permission claiming the `all` subject.
   */
  | 'categorical_exclusion';

/**
 * The one rule that says whether a requested permission can be granted at all.
 * It returns the cause rather than throwing, so the consent surface and the
 * consent act planner can report and refuse it without writing anything
 * (#1150).
 *
 * Causes are tested in a fixed order: categorical exclusion, no catalog row,
 * wildcard subject, unbound unit scope.
 */
export function consentUngrantableCause(input: {
  /** The catalog's risk for the slug; undefined when it has no row. */
  readonly catalogRisk: RiskLevel | undefined;
  readonly check: Pick<NormalizedPermissionRequest, 'canonicalSlug' | 'origin'>;
  readonly corePermission: ConsentCatalogPermission | undefined;
  readonly decidingScope: PluginGrantScope;
  /** A staged manifest's new declared permission has no catalog row until activation, and is grantable. */
  readonly source: ConsentManifestSource;
}): ConsentUngrantableCause | null {
  const { check, decidingScope, corePermission, catalogRisk, source } = input;

  if (check.origin === 'plugin') {
    // The exclusions apply to the BARE form too: a naively mapped `manage:all`
    // would read as CASL's universal subject, and a declared `manage:plugin`
    // invites the self-escalation the administration exclusion shuts out.
    const parsed = parsePluginPermissionSlug(check.canonicalSlug);

    if (
      isPluginAdministrationSlug(parsed.bareSlug) ||
      parsed.subjectPath === 'all' ||
      parsed.subjectPath.startsWith('all:')
    ) {
      return 'categorical_exclusion';
    }

    // Activation creates a staged manifest's catalog row, so its absence
    // only blocks a permission the active manifest already declares.
    return catalogRisk === undefined && source === 'active' ? 'no_catalog_row' : null;
  }

  if (isPluginAdministrationSlug(check.canonicalSlug)) {
    return 'categorical_exclusion';
  }

  if (corePermission === undefined || catalogRisk === undefined) {
    return 'no_catalog_row';
  }

  const { wildcardSubject, unboundedUnitScope } = consentCatalogFlags({
    origin: check.origin,
    decidingScope,
    corePermission,
  });

  if (wildcardSubject) {
    return 'wildcard_subject';
  }

  return unboundedUnitScope ? 'unbound_unit_scope' : null;
}
