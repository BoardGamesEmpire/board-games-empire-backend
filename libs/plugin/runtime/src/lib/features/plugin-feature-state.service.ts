import { assertPluginUnit, type PluginUnit } from '@bge/actor-context';
import { DatabaseService, loadPluginUnitEnablement } from '@bge/database';
import { resolveLocalizedString, type NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { unitConsumesConsentScope, type ConsentCheckClassification } from '../consent/consent-classification.types';
import { PluginConsentCheckClassifier } from '../consent/plugin-consent-check-classifier.service';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { PluginFeatureStateManifestError } from './feature-state.errors';

/**
 * Why a feature is not active, strongest-first. `denied` and `pending` are
 * per-check consent states (a durable refusal vs. a decision nobody has
 * made — which includes a grant whose `decidedRiskLevel` no longer covers
 * the permission's current risk, since that consent must be given
 * again). `suspended` is the unit-level suspension state and is reported
 * only when the feature's consent is otherwise complete — an actionable
 * denial/pending always wins the `reason` slot, because it names what the
 * unit can actually do about it.
 */
export type PluginFeatureBlockReason = 'denied' | 'pending' | 'suspended';

export interface PluginFeatureState {
  /** Manifest `features[].name` — the stable identifier. */
  readonly name: string;
  /** Localized per the requested locale with the manifest fallback chain. */
  readonly displayName: string;
  readonly description: string;
  readonly state: 'active' | 'disabled';
  /** `null` exactly when `state` is `active`. */
  readonly reason: PluginFeatureBlockReason | null;
  /** Canonical slugs of the bound checks blocking activation (empty when active or purely suspended). */
  readonly blockingSlugs: readonly string[];
  /**
   * Bound checks decided on a DIFFERENT unit axis, which this unit's
   * resolution never consumes (the read path's grant scoping, #60) and whose state is therefore
   * per-unit over there — the same checks the consent surface models as
   * `per-unit`. Non-empty means this viewpoint does not fully determine the
   * feature: `state` describes only the gates THIS unit's resolution owns
   * (a Server unit asking about a household-consented feature sees `active`
   * with the household slugs listed here, not a false fleet-wide green).
   * A "degraded anywhere?" answer (#67) must ask the owning units.
   */
  readonly perUnitSlugs: readonly string[];
}

export interface PluginFeatureUnitState {
  readonly plugin: {
    readonly id: string;
    readonly slug: string;
  };
  readonly unit: PluginUnit;
  /**
   * The full operational predicate: plugin enabled and not tombstoned, AND
   * (for Household/User units) the unit's enablement row exists with
   * `enabled && !suspendedForConsent`. Deliberately separate from feature
   * `state`: a feature is active iff its owned checks are granted
   * and the unit is not consent-suspended — a unit that merely switched the
   * plugin off keeps its consent-derived states, and `served: false` is
   * what tells the caller nothing runs right now.
   */
  readonly served: boolean;
  readonly suspendedForConsent: boolean;
  readonly features: readonly PluginFeatureState[];
}

/**
 * The queryable "is feature X active for unit Y" derivation (#60),
 * landed where it is consumed. Inputs are exactly the C3
 * contract: `PluginGrant` rows (Granted confers, Denied is durable, no row
 * is pending), per-unit suspension state, and the manifest's
 * `checks[].feature` → `features[].name` binding (validated at install).
 *
 * A feature is ACTIVE for a unit iff every bound check the unit's
 * resolution consumes has a conferring `Granted` row and the unit is not
 * consent-suspended. "The checks the unit's resolution consumes"
 * (`unitConsumesConsentScope`) mirrors the ability read path's grant
 * scoping (#60): server-consented checks apply to EVERY unit (they are
 * the plugin's global authority — a server-denied check dead-ends the
 * feature everywhere), plus the checks owned by the unit's own scope.
 * Checks owned by a DIFFERENT unit axis (user-consented checks while
 * asking about a household) are excluded for the same reason the ability
 * excludes those grants: they never enter this unit's resolution — and
 * they are reported in `perUnitSlugs` so a viewpoint that does not fully
 * determine a feature says so instead of reading as a fleet-wide green.
 *
 * Per-check states come from `PluginConsentCheckClassifier` — shared with
 * the consent presentation so the feature answer and the consent screen
 * cannot disagree about what `pending` or `denied` means. Risk coverage
 * applies exactly as in the read path: a `Granted` row whose
 * `decidedRiskLevel` no longer covers the permission's current risk
 * confers nothing and reports `pending` (the decision must be re-made), as
 * does a grant whose catalog row is gone.
 *
 * No caching: a consent decision must be visible on the next read,
 * and no invalidation path exists yet.
 */
@Injectable()
export class PluginFeatureStateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly classifier: PluginConsentCheckClassifier,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Resolves the feature states for one (plugin, unit). Returns `null`
   * when no `Plugin` row exists. `locale` is the requester's resolved
   * catalog locale (the C4 edge reads it from CLS); it falls back to the
   * host default, and each localized string falls back through the
   * manifest chain.
   */
  async resolveForUnit(pluginId: string, unit: PluginUnit, locale?: string): Promise<PluginFeatureUnitState | null> {
    // Same boundary posture as every other unit ingress (the CLS scope, the
    // gRPC interceptor, the queue envelope): a structurally invalid unit —
    // C4 builds these from request input — fails here, loudly, instead of
    // surfacing as an opaque Prisma validation error mid-derivation.
    assertPluginUnit(unit, `Feature-state resolution for plugin '${pluginId}'`);

    // Independent reads: the unit-enablement row is keyed by (unit, pluginId).
    const [plugin, unitState] = await Promise.all([
      this.db.plugin.findUnique({
        where: { id: pluginId },
        select: { id: true, slug: true, version: true, enabled: true, uninstalledAt: true, manifestJson: true },
      }),
      loadPluginUnitEnablement(this.db, pluginId, unit),
    ]);

    if (!plugin) {
      return null;
    }

    // Tombstoned plugins short-circuit BEFORE manifest re-validation: their
    // grants and catalog rows are purged, there is nothing to derive,
    // and a stale stored manifest must not turn "uninstalled" into a 5xx.
    if (plugin.uninstalledAt !== null) {
      return {
        plugin: { id: plugin.id, slug: plugin.slug },
        unit,
        served: false,
        suspendedForConsent: unitState.suspendedForConsent,
        features: [],
      };
    }

    const validated = revalidateStoredManifest(
      { slug: plugin.slug, version: plugin.version, manifestJson: plugin.manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginFeatureStateManifestError(pluginSlug, detail, issues),
    );
    const served = plugin.enabled && unitState.enabled && !unitState.suspendedForConsent;

    const featureBound = validated.permissionChecks.filter((check) => check.feature !== undefined);
    const consumedChecks = featureBound.filter((check) => unitConsumesConsentScope(check.consentScope, unit));
    const { decisions } = await this.classifier.classify(plugin.id, unit, consumedChecks);

    const resolveText = (value: Parameters<typeof resolveLocalizedString>[0]): string =>
      resolveLocalizedString(value, {
        locale: locale ?? this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      });

    const features = validated.manifest.features.map((feature): PluginFeatureState => {
      const bound = consumedChecks.filter((check) => check.feature === feature.name);
      const blocking = bound.filter((check) => decisions.get(check.canonicalSlug)?.decision !== 'granted');
      const reason = this.blockReason(unitState.suspendedForConsent, blocking, decisions);

      return {
        name: feature.name,
        displayName: resolveText(feature.displayName),
        description: resolveText(feature.description),
        state: reason === null ? 'active' : 'disabled',
        reason,
        blockingSlugs: blocking.map((check) => check.canonicalSlug).sort(),
        perUnitSlugs: featureBound
          .filter((check) => check.feature === feature.name && !unitConsumesConsentScope(check.consentScope, unit))
          .map((check) => check.canonicalSlug)
          .sort(),
      };
    });

    return {
      plugin: { id: plugin.id, slug: plugin.slug },
      unit,
      served,
      suspendedForConsent: unitState.suspendedForConsent,
      features,
    };
  }

  /**
   * Reason precedence: an actionable per-check state (denied > pending)
   * outranks the unit-level suspension, because it names what the unit can
   * actually do about it; suspension is reported only when the feature's
   * consumed consent is otherwise complete. `null` means active.
   */
  private blockReason(
    suspended: boolean,
    blocking: readonly NormalizedPermissionRequest[],
    decisions: ConsentCheckClassification['decisions'],
  ): PluginFeatureBlockReason | null {
    if (blocking.length > 0) {
      const denied = blocking.some((check) => decisions.get(check.canonicalSlug)?.decision === 'denied');

      return denied ? 'denied' : 'pending';
    }

    return suspended ? 'suspended' : null;
  }
}
