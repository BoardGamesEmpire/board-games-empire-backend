import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  grantScopeCoordinatesForUnit,
  hasBoundingConditions,
  PluginGrantStatus,
  riskCovers,
  type RiskLevel,
} from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { Injectable, Logger } from '@nestjs/common';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import {
  unitConsumesConsentScope,
  type ClassifiedConsentCheck,
  type ConsentCheckClassification,
  type ConsentCheckDecision,
} from './consent-classification.types';

/**
 * Classifies manifest checks against a unit's `PluginGrant` rows AT EACH
 * CHECK'S DECIDING SCOPE: a server-consented check is answered by the Server
 * sentinel row, a household/user-consented one by the unit's own row — a row
 * at any other scope never matches, so a grant recorded by a principal that
 * does not own the check confers nothing here either.
 *
 * One classification, two consumers (feature-state derivation and consent
 * presentation), for the same reason the suspension predicates share their
 * covering test: `pending` and `denied` MUST mean the same thing on the
 * consent screen and in the feature answer, or a unit is shown a decision
 * surface that disagrees with what its features report.
 *
 * Risk semantics mirror the ability read path (#60), not the runtime's
 * `unitConsentSatisfied`: a vanished catalog row means the grant confers
 * nothing (pending), including own-namespace rows — read fresh from
 * `PluginPermission` rather than assumed `Low`, the same defense-in-depth
 * the read path applies should a row ever violate the explicit-Low lock
 * on plugin-declared rows (#59).
 */
@Injectable()
export class PluginConsentCheckClassifier {
  private readonly logger = new Logger(PluginConsentCheckClassifier.name);

  constructor(private readonly db: DatabaseService) {}

  async classify(
    pluginId: string,
    unit: PluginUnit,
    checks: readonly NormalizedPermissionRequest[],
  ): Promise<ConsentCheckClassification> {
    if (checks.length === 0) {
      return { decisions: new Map(), currentRiskBySlug: new Map() };
    }

    const addressable = checks.filter((check) => unitConsumesConsentScope(check.consentScope, unit));

    // Independent queries: grants over the addressable slugs only (other
    // axes' rows are not this unit's to read), catalog over every check.
    const [grants, catalog] = await Promise.all([
      addressable.length === 0
        ? []
        : this.db.pluginGrant.findMany({
            where: {
              pluginId,
              status: { in: [PluginGrantStatus.Granted, PluginGrantStatus.Denied] },
              OR: grantScopeCoordinatesForUnit(unit),
              permissionSlug: { in: addressable.map((check) => check.canonicalSlug) },
            },
            select: { permissionSlug: true, scopeType: true, status: true, decidedRiskLevel: true },
          }),
      this.loadCatalogState(pluginId, checks),
    ]);
    const grantByScopeAndSlug = new Map(grants.map((grant) => [`${grant.scopeType}|${grant.permissionSlug}`, grant]));

    const decisions = new Map<string, ClassifiedConsentCheck>();

    for (const check of addressable) {
      const decidingScope = CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope];
      const grant = grantByScopeAndSlug.get(`${decidingScope}|${check.canonicalSlug}`);
      const currentRiskLevel = catalog.riskBySlug.get(check.canonicalSlug) ?? null;
      const wildcardSubject = catalog.wildcardSlugs.has(check.canonicalSlug);
      // Unit-boundedness (#60): a condition-free core permission consented
      // at household/user scope confers nothing — mirrors the ability read
      // path exactly. Server-consented checks are exempt.
      const unboundedUnitScope =
        check.origin === 'core' &&
        check.consentScope !== 'server' &&
        catalog.unconditionedCoreSlugs.has(check.canonicalSlug);

      decisions.set(check.canonicalSlug, {
        decision: this.decide(
          pluginId,
          check.canonicalSlug,
          grant,
          currentRiskLevel,
          wildcardSubject,
          unboundedUnitScope,
        ),
        decidedRiskLevel: grant?.decidedRiskLevel ?? null,
        // Not marked stale when the grant cannot confer for structural
        // reasons: staleness says "re-consent fixes this", and it does not.
        staleRisk:
          grant !== undefined &&
          grant.status === PluginGrantStatus.Granted &&
          !wildcardSubject &&
          !unboundedUnitScope &&
          currentRiskLevel !== null &&
          !riskCovers(grant.decidedRiskLevel, currentRiskLevel),
      });
    }

    return { decisions, currentRiskBySlug: catalog.riskBySlug };
  }

  /**
   * `Denied` is durable refusal; a missing row, a stale `decidedRiskLevel`,
   * a vanished catalog row, or a subject drifted to the `all` wildcard are
   * all `pending` — the decision (or re-decision) has not been made, and the
   * ability confers nothing for them.
   */
  private decide(
    pluginId: string,
    canonicalSlug: string,
    grant: { readonly status: PluginGrantStatus; readonly decidedRiskLevel: RiskLevel } | undefined,
    currentRiskLevel: RiskLevel | null,
    wildcardSubject: boolean,
    unboundedUnitScope: boolean,
  ): ConsentCheckDecision {
    if (!grant) {
      return 'pending';
    }

    if (grant.status === PluginGrantStatus.Denied) {
      return 'denied';
    }

    if (wildcardSubject) {
      this.logger.warn(
        `Plugin ${pluginId} check '${canonicalSlug}' points at a permission whose subject drifted to the ` +
          `'all' wildcard after consent; reporting pending (the ability confers nothing)`,
      );

      return 'pending';
    }

    if (unboundedUnitScope) {
      this.logger.warn(
        `Plugin ${pluginId} check '${canonicalSlug}' names a condition-free permission consented at unit ` +
          'scope; nothing bounds that authority to the consenting unit — reporting pending (the ability ' +
          'confers nothing)',
      );

      return 'pending';
    }

    if (currentRiskLevel === null) {
      this.logger.debug(`Plugin ${pluginId} check '${canonicalSlug}' has no catalog row; reporting pending`);

      return 'pending';
    }

    return riskCovers(grant.decidedRiskLevel, currentRiskLevel) ? 'granted' : 'pending';
  }

  /**
   * Catalog state per canonical slug: current risk (core and own-namespace
   * rows from their respective catalogs) plus the core slugs whose subject
   * drifted to the `all` wildcard — grant-time forbids wildcard subjects
   * (#59), so their grants confer nothing at consumption.
   */
  private async loadCatalogState(
    pluginId: string,
    checks: readonly NormalizedPermissionRequest[],
  ): Promise<{ riskBySlug: Map<string, RiskLevel>; wildcardSlugs: Set<string>; unconditionedCoreSlugs: Set<string> }> {
    const coreSlugs = checks.filter((check) => check.origin === 'core').map((check) => check.canonicalSlug);
    const ownSlugs = checks.filter((check) => check.origin === 'plugin').map((check) => check.canonicalSlug);

    const [corePermissions, ownPermissions] = await Promise.all([
      coreSlugs.length > 0
        ? this.db.permission.findMany({
            where: { slug: { in: coreSlugs } },
            select: { slug: true, riskLevel: true, subject: true, conditions: true },
          })
        : [],
      ownSlugs.length > 0
        ? this.db.pluginPermission.findMany({
            where: { pluginId, slug: { in: ownSlugs } },
            select: { slug: true, riskLevel: true },
          })
        : [],
    ]);

    return {
      riskBySlug: new Map(
        [...corePermissions, ...ownPermissions].map((permission) => [permission.slug, permission.riskLevel] as const),
      ),
      wildcardSlugs: new Set(
        corePermissions.filter((permission) => permission.subject === 'all').map((permission) => permission.slug),
      ),
      unconditionedCoreSlugs: new Set(
        corePermissions
          .filter((permission) => !hasBoundingConditions(permission.conditions))
          .map((permission) => permission.slug),
      ),
    };
  }
}
