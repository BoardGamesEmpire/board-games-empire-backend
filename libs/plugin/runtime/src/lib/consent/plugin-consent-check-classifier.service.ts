import type { PluginUnit } from '@bge/actor-context';
import type { Prisma, RiskLevel } from '@bge/database';
import {
  CONSENT_UNIT_BINDING_REFUSAL,
  DatabaseService,
  grantScopeCoordinatesForUnit,
  PluginGrantStatus,
  riskCovers,
} from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { Injectable, Logger } from '@nestjs/common';
import { consentUngrantableCause } from '../grants/consent-grantability';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from '../grants/consent-scope.map';
import type { ConsentCatalogPermission } from './consent-catalog-flags';
import { consentCatalogFlags } from './consent-catalog-flags';
import type {
  ClassifiedConsentCheck,
  ConsentCheckClassification,
  ConsentCheckDecision,
  ConsentManifestSource,
} from './consent-classification.types';
import { unitConsumesConsentScope } from './consent-classification.types';
import { presentedRiskLevel } from './presented-risk-level';

/**
 * Classifies manifest checks against a unit's `PluginGrant` rows AT EACH
 * CHECK'S DECIDING SCOPE: a server-consented check is answered by the Server
 * sentinel row, a household/user-consented one by the unit's own row — a row
 * at any other scope never matches, so a grant recorded by a principal that
 * does not own the check confers nothing here either.
 *
 * One rule, every consumer: `decideConsentCheck` below is the one
 * implementation of "does this check confer". The standing service (and
 * through it feature state and the inventory) and the consent presentation
 * read it through `classify`; activation's re-consent announcement applies the
 * same function to the rows it has already read (#1149). `pending` and
 * `denied` MUST mean the same thing on the consent screen, in the feature
 * answer and in who gets announced, or a unit is shown a decision surface that
 * disagrees with what its features report.
 *
 * The missing-row and risk rules here are the same ones the ability read path
 * applies when it intersects Granted rows (#60): a vanished catalog row means
 * the grant confers nothing (pending), including own-namespace rows — read fresh from
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
    options: ConsentClassifyOptions = {},
  ): Promise<ConsentCheckClassification> {
    const { source = 'active' } = options;
    const client = options.client ?? this.db;

    if (checks.length === 0) {
      return { decisions: new Map(), currentRiskBySlug: new Map() };
    }

    const addressable = checks.filter((check) => unitConsumesConsentScope(check.consentScope, unit));

    // Independent queries: grants over the addressable slugs only (other
    // axes' rows are not this unit's to read), catalog over every check.
    const [grants, catalog] = await Promise.all([
      addressable.length === 0
        ? []
        : client.pluginGrant.findMany({
            where: {
              pluginId,
              status: { in: [PluginGrantStatus.Granted, PluginGrantStatus.Denied] },
              OR: grantScopeCoordinatesForUnit(unit),
              permissionSlug: { in: addressable.map((check) => check.canonicalSlug) },
            },
            select: { permissionSlug: true, scopeType: true, status: true, decidedRiskLevel: true },
          }),
      this.loadCatalogState(client, pluginId, checks),
    ]);
    const grantByScopeAndSlug = new Map(grants.map((grant) => [`${grant.scopeType}|${grant.permissionSlug}`, grant]));

    const decisions = new Map<string, ClassifiedConsentCheck>();

    for (const check of addressable) {
      const decidingScope = CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope];
      const grant = grantByScopeAndSlug.get(`${decidingScope}|${check.canonicalSlug}`);
      const currentRiskLevel = catalog.riskBySlug.get(check.canonicalSlug) ?? null;
      const { wildcardSubject, attendanceOnlySubject, unboundedUnitScope } = consentCatalogFlags({
        origin: check.origin,
        decidingScope,
        corePermission: catalog.corePermissionsBySlug.get(check.canonicalSlug),
      });

      // Under a staged manifest, a declared permission has no catalog row
      // until activation creates it at the Low a declared row is locked to,
      // so a pre-consent is judged against that Low, as the consent surface
      // shows it. Under the active manifest a missing row confers nothing
      // (#1150).
      const judgedRiskLevel =
        source === 'staged' && check.origin === 'plugin'
          ? presentedRiskLevel(check.origin, currentRiskLevel)
          : currentRiskLevel;

      const { decision, cause } = this.decide(pluginId, check.canonicalSlug, {
        grant,
        currentRiskLevel: judgedRiskLevel,
        wildcardSubject,
        attendanceOnlySubject,
        unboundedUnitScope,
      });

      decisions.set(check.canonicalSlug, {
        decision,
        decidedRiskLevel: grant?.decidedRiskLevel ?? null,
        // Not marked stale when the grant cannot confer for structural
        // reasons: staleness says "re-consent fixes this", and it does not.
        staleRisk: cause === 'stale_risk',
        // A property of the permission and its deciding scope, so it is
        // reported whether or not a decision exists (#1150).
        ungrantable: consentUngrantableCause({
          check,
          decidingScope,
          corePermission: catalog.corePermissionsBySlug.get(check.canonicalSlug),
          catalogRisk: currentRiskLevel ?? undefined,
          source,
        }),
      });
    }

    return { decisions, currentRiskBySlug: catalog.riskBySlug };
  }

  /**
   * The shared rule, with the classifier's logging on the two causes that
   * point at catalog drift an operator should hear about.
   */
  private decide(
    pluginId: string,
    canonicalSlug: string,
    input: ConsentCheckDecisionInput,
  ): ReturnType<typeof decideConsentCheck> {
    const result = decideConsentCheck(input);
    const { cause } = result;

    if (cause === 'wildcard_subject') {
      this.logger.warn(
        `Plugin ${pluginId} check '${canonicalSlug}' points at a permission whose subject drifted to the ` +
          `'all' wildcard after consent; reporting pending (the ability confers nothing)`,
      );
    } else if (cause === 'unbound_unit_scope') {
      this.logger.warn(
        `Plugin ${pluginId} requested permission '${canonicalSlug}' is consented at unit scope, but ` +
          `${CONSENT_UNIT_BINDING_REFUSAL} — reporting pending (the ability confers nothing, #591)`,
      );
    } else if (cause === 'no_catalog_row') {
      this.logger.debug(`Plugin ${pluginId} check '${canonicalSlug}' has no catalog row; reporting pending`);
    }

    return result;
  }

  /**
   * Catalog state per canonical slug: current risk (core and own-namespace
   * rows from their respective catalogs) and the core rows themselves, which
   * `consentCatalogFlags` reads for the wildcard-subject and unit-binding
   * rules.
   */
  private async loadCatalogState(
    client: ConsentReadClient,
    pluginId: string,
    checks: readonly NormalizedPermissionRequest[],
  ): Promise<{
    corePermissionsBySlug: Map<string, ConsentCatalogPermission>;
    riskBySlug: Map<string, RiskLevel>;
  }> {
    const coreSlugs = checks.filter((check) => check.origin === 'core').map((check) => check.canonicalSlug);
    const ownSlugs = checks.filter((check) => check.origin === 'plugin').map((check) => check.canonicalSlug);

    const [corePermissions, ownPermissions] = await Promise.all([
      coreSlugs.length > 0
        ? client.permission.findMany({
            // A retired row (#235) reads as vanished, exactly as the ability
            // path reads it: the grant confers nothing, so the check is pending.
            where: { slug: { in: coreSlugs }, retiredAt: null },
            select: {
              slug: true,
              riskLevel: true,
              action: true,
              subject: true,
              fields: true,
              conditions: true,
              inverted: true,
            },
          })
        : [],
      ownSlugs.length > 0
        ? client.pluginPermission.findMany({
            where: { pluginId, slug: { in: ownSlugs } },
            select: { slug: true, riskLevel: true },
          })
        : [],
    ]);

    return {
      riskBySlug: new Map(
        [...corePermissions, ...ownPermissions].map((permission) => [permission.slug, permission.riskLevel] as const),
      ),
      corePermissionsBySlug: new Map(corePermissions.map((permission) => [permission.slug, permission] as const)),
    };
  }
}

// The flags live in their own module, which the pure grantability rule imports
// without this service; re-exported here for the classifier's other readers (#1150).
export { consentCatalogFlags, type ConsentCatalogPermission } from './consent-catalog-flags';

/** What the classifier reads through: the request's database, or a transaction a caller holds open (#1150). */
export type ConsentReadClient = Prisma.TransactionClient | DatabaseService;

export interface ConsentClassifyOptions {
  /** Read through this client, so a consent act's transaction sees its own writes. Default: the service's database. */
  readonly client?: ConsentReadClient;

  /**
   * Which manifest the requested permissions come from. A staged manifest's
   * new declared permission has no catalog row until activation creates it,
   * and is still grantable. Default `active`.
   */
  readonly source?: ConsentManifestSource;
}

export interface ConsentCheckDecisionInput {
  /** The core permission is on an attendance-only resource type, which no plugin reaches (#1543). */
  readonly attendanceOnlySubject: boolean;

  /** Today's catalog risk, `null` when the catalog row is gone. */
  readonly currentRiskLevel: RiskLevel | null;

  /** The row at the check's deciding scope, `Granted` or `Denied`; `undefined` when none exists. */
  readonly grant: { readonly decidedRiskLevel: RiskLevel; readonly status: PluginGrantStatus } | undefined;

  readonly unboundedUnitScope: boolean;
  readonly wildcardSubject: boolean;
}

/**
 * Why a check does not confer, when it does not. `null` for a conferring
 * check.
 */
export type ConsentCheckNonConferringCause =
  | 'no_row'
  | 'denied'
  | 'wildcard_subject'
  | 'attendance_only_subject'
  | 'unbound_unit_scope'
  | 'no_catalog_row'
  | 'stale_risk';

/**
 * The one rule for "does this check confer" (#1149), pure so that every
 * reader applies it to rows it has already loaded. `Denied` is durable
 * refusal; a missing row, a stale `decidedRiskLevel`, a vanished catalog row,
 * a subject drifted to the `all` wildcard, a permission on an attendance-only
 * resource type (#1543), or a unit-scope grant that binds no unit are all
 * `pending` — the decision (or re-decision) has not been made,
 * and the ability confers nothing for them. The missing-row and risk rules are
 * the same ones the ability read path applies when it intersects Granted rows
 * (#60): a vanished catalog row means the grant confers nothing, including
 * own-namespace rows, read fresh from `PluginPermission` rather than assumed
 * `Low` (#59).
 */
export function decideConsentCheck(input: ConsentCheckDecisionInput): {
  readonly cause: ConsentCheckNonConferringCause | null;
  readonly decision: ConsentCheckDecision;
} {
  const { grant, currentRiskLevel, wildcardSubject, attendanceOnlySubject, unboundedUnitScope } = input;

  if (!grant) {
    return { decision: 'pending', cause: 'no_row' };
  }

  if (grant.status === PluginGrantStatus.Denied) {
    return { decision: 'denied', cause: 'denied' };
  }

  if (wildcardSubject) {
    return { decision: 'pending', cause: 'wildcard_subject' };
  }

  if (attendanceOnlySubject) {
    return { decision: 'pending', cause: 'attendance_only_subject' };
  }

  if (unboundedUnitScope) {
    return { decision: 'pending', cause: 'unbound_unit_scope' };
  }

  if (currentRiskLevel === null) {
    return { decision: 'pending', cause: 'no_catalog_row' };
  }

  return riskCovers(grant.decidedRiskLevel, currentRiskLevel)
    ? { decision: 'granted', cause: null }
    : { decision: 'pending', cause: 'stale_risk' };
}
