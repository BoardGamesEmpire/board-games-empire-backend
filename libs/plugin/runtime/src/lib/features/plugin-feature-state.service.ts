import { assertPluginUnit, type PluginUnit } from '@bge/actor-context';
import { DatabaseService, loadPluginUnitEnablement, PluginScope } from '@bge/database';
import { resolveLocalizedString } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { unitConsumesConsentScope } from '../consent/consent-classification.types';
import { PluginConsentStandingService } from '../consent/plugin-consent-standing.service';
import type { ConsentOutstandingCheck, PluginConsentStanding } from '../consent/plugin-consent-standing.types';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { derivePluginUnitState, type PluginUnitStateCode } from '../units/plugin-unit-state';
import { PluginUnitScopeError } from '../units/unit.errors';
import {
  PluginFeatureStateManifestError,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateTombstonedError,
} from './feature-state.errors';

/**
 * Why a feature is not active, strongest-first. Both are per-check consent
 * states: `denied` is a durable refusal at whichever scope decides the
 * check, `pending` a decision nobody has made — which includes a grant whose
 * `decidedRiskLevel` no longer covers the permission's current risk, since
 * that consent must be given again. A denial outranks a pending decision
 * because it says the feature is not merely waiting. Whether this unit can
 * act on it is the check's kind under `consent` (#1149): a server admin's
 * refusal reads `denied` here and `outstanding_elsewhere` there. A unit that
 * owes a required permission is not a feature reason: `state` on the unit
 * says so.
 */
export type PluginFeatureBlockReason = 'denied' | 'pending';

export interface PluginFeatureState {
  /** Manifest `features[].name` — the stable identifier. */
  readonly name: string;
  /** Localized per the requested locale with the manifest fallback chain. */
  readonly displayName: string;
  readonly description: string;
  readonly state: 'active' | 'disabled';
  /** `null` exactly when `state` is `active`. */
  readonly reason: PluginFeatureBlockReason | null;
  /** Canonical slugs of the bound checks blocking activation (empty when active). */
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
   * the unit's enablement is on with no dormant reason. Consent never enters
   * it: a unit owing a required permission keeps running on the grants it gave
   * (the ability denies what it has not granted), so served is not what says a
   * review is waiting (#1149).
   */
  readonly served: boolean;
  /**
   * The plugin's server switch. Reported beside `state` so a client can say
   * why a switched-on unit reads `unavailable`: this, or a scope that no
   * longer admits the unit (#1149).
   */
  readonly serverEnabled: boolean;
  /**
   * The stable code for the unit's state: off, on, review_pending,
   * needs_configuration or unavailable. Carries what the server switch,
   * dormancy and consent each add, so none is reported separately.
   */
  readonly state: PluginUnitStateCode;
  /** Required permissions the unit still owes and optional ones switched off. */
  readonly consent: PluginConsentStanding;
  readonly features: readonly PluginFeatureState[];
}

/**
 * The queryable "is feature X active for unit Y" derivation (#60),
 * landed where it is consumed. Inputs are exactly the C3
 * contract: `PluginGrant` rows (Granted confers, Denied is durable, no row
 * is pending), the manifest's `checks[].feature` → `features[].name` binding
 * (validated at install) and the permission catalog. Nothing is stored: the
 * unit state code is worked out from those on every read (#1149), which
 * removes the stored flag this read used to trust and the bugs that came with
 * it (#1061, #1063, #1147).
 *
 * A feature is ACTIVE for a unit iff every bound check the unit's
 * resolution consumes has a conferring `Granted` row. A unit that still owes
 * a required permission keeps running on the grants it gave; `state` says
 * what is waiting. "The checks the unit's resolution consumes"
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
 * Per-check states come from `PluginConsentStandingService` (one
 * classification per read), so the feature answer and the consent surface
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
    private readonly standing: PluginConsentStandingService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * The slug-addressed entry point for the HTTP edge (#323): the 404/410
   * distinction as typed errors, then the id-addressed derivation below.
   * The tombstone throw deliberately diverges from `resolveForUnit`'s
   * served-false short-circuit — see {@link PluginFeatureStateTombstonedError}.
   *
   * A HOUSEHOLD viewpoint on a server-scope plugin is refused the same way
   * the household writers refuse it: the manifest gate forbids
   * household-scope consent there, so no enablement row can exist, and a
   * served-false body would present impossible unit state as a real
   * degraded unit — indistinguishable from never-enabled, with an "enable
   * it" lever that 422s. The USER viewpoint is deliberately NOT refused:
   * user-scope consent is permitted at ANY plugin scope (#225), a
   * `Granted` user decision creates a real `UserPlugin` anchor on a
   * server-scope plugin, and the user's own enable/disable operates on it
   * — refusing the read would leave them toggling a unit whose blocked
   * features they could never see.
   *
   * The guards BRACKET the derivation rather than merely preceding it. Run
   * only before, they read a strictly earlier snapshot than the state they
   * are vouching for, and the failure is not symmetric: an uninstall landing
   * in the gap renders `served: false` where this entry point promises 410 —
   * differently true of an unserved unit — but a household→server activation
   * landing there produces `served: true` for a surface the scope rule says
   * cannot exist, because activation retires no unit rows (#369) and the
   * derivation never re-reads `scope`. That one is simply wrong, so a body
   * now reaches the client only if the plugin was still living and still
   * addressable on a read taken AFTER the derivation.
   *
   * A second small read rather than one transaction: the derivation is
   * shared with in-process callers that must not inherit a repeatable-read
   * transaction, and the guards need to bracket it, not serialize it. What
   * remains open is only the tail — nothing stops an activation committing
   * after the closing read — but a `served: true` body then describes a
   * scope that was correct at a point after the state was computed, which is
   * the same guarantee every uncached read gives.
   */
  async resolveForUnitBySlug(slug: string, unit: PluginUnit, locale?: string): Promise<PluginFeatureUnitState> {
    const plugin = await this.db.plugin.findUnique({
      where: { slug },
      select: { id: true, scope: true, uninstalledAt: true },
    });

    if (plugin === null) {
      throw new PluginFeatureStateNotFoundError(slug);
    }

    this.assertAddressable(slug, unit, plugin);

    const state = await this.resolveForUnit(plugin.id, unit, locale);

    // Unreachable while Plugin rows are tombstoned rather than deleted;
    // kept as the honest rendering should that ever change under this read.
    if (state === null) {
      throw new PluginFeatureStateNotFoundError(slug);
    }

    const after = await this.db.plugin.findUnique({
      where: { id: plugin.id },
      select: { scope: true, uninstalledAt: true },
    });

    if (after === null) {
      throw new PluginFeatureStateNotFoundError(slug);
    }

    this.assertAddressable(slug, unit, after);

    return state;
  }

  /**
   * The entry point's two refusals, applied to one snapshot of the plugin
   * row. Shared by the reads that open and close the derivation so the pair
   * cannot drift apart — a closing guard that checked less than the opening
   * one would be worse than none, since it would read as a bracket.
   */
  private assertAddressable(
    slug: string,
    unit: PluginUnit,
    plugin: { readonly scope: PluginScope; readonly uninstalledAt: Date | null },
  ): void {
    if (plugin.uninstalledAt !== null) {
      throw new PluginFeatureStateTombstonedError(slug, plugin.uninstalledAt);
    }

    if (plugin.scope === PluginScope.Server && unit.scopeType === 'Household') {
      throw new PluginUnitScopeError(slug, plugin.scope.toLowerCase());
    }
  }

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
        serverEnabled: false,
        state: 'off',
        consent: { outstanding: [], optionalOff: [] },
        features: [],
      };
    }

    const validated = revalidateStoredManifest(
      { slug: plugin.slug, version: plugin.version, manifestJson: plugin.manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginFeatureStateManifestError(pluginSlug, detail, issues),
    );
    // Dormancy is an independent component of the predicate: the household's
    // `enabled` intent survives a scope narrowing or a schema tightening, so
    // a unit can be switched on and still serve nothing (#369). Consent is
    // deliberately absent (#1149).
    const served = plugin.enabled && unitState.enabled && unitState.dormantReason === null;

    const { standing: consent, refusedSlugs } = await this.standing.resolveDetailed(
      plugin.id,
      unit,
      validated.permissionChecks,
      locale,
    );
    const state = derivePluginUnitState({
      anchored: unitState.anchored,
      // The server switch IS the Server unit's own switch, so that unit reads
      // `off` when it is off; a household or user unit reads `unavailable`,
      // since the switch is not theirs to flip (#1149).
      enabled: unit.scopeType === 'Server' ? plugin.enabled : unitState.enabled,
      serverEnabled: plugin.enabled,
      dormantReason: unitState.dormantReason,
      outstandingCount: consent.outstanding.length,
    });

    const featureBound = validated.permissionChecks.filter((check) => check.feature !== undefined);
    // One classification per read: every check that does not confer is already
    // in the standing, so features are derived from it, not from a second pass.
    const notConferring = [...consent.outstanding, ...consent.optionalOff];

    const resolveText = (value: Parameters<typeof resolveLocalizedString>[0]): string =>
      resolveLocalizedString(value, {
        locale: locale ?? this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      });

    const features = validated.manifest.features.map((feature): PluginFeatureState => {
      const blocking = notConferring.filter((check) => check.feature === feature.name);
      const reason = this.blockReason(blocking, refusedSlugs);

      return {
        name: feature.name,
        displayName: resolveText(feature.displayName),
        description: resolveText(feature.description),
        state: reason === null ? 'active' : 'disabled',
        reason,
        blockingSlugs: blocking.map((check) => check.slug).sort(),
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
      serverEnabled: plugin.enabled,
      state,
      consent,
      features,
    };
  }

  /**
   * `denied` when a durable refusal blocks the feature, at whichever scope
   * decides the check: a server admin's refusal dead-ends the feature for a
   * household as surely as the household's own would, and a client told
   * `pending` would say the decision is still waiting when it has been made.
   * Who can act on it is the check's kind under `consent` (`refused` for the
   * unit's own, `outstanding_elsewhere` for another scope's). Every other
   * non-conferring check reads `pending`; `null` means active (#1149).
   */
  private blockReason(
    blocking: readonly ConsentOutstandingCheck[],
    refusedSlugs: ReadonlySet<string>,
  ): PluginFeatureBlockReason | null {
    if (blocking.length === 0) {
      return null;
    }

    return blocking.some((check) => refusedSlugs.has(check.slug)) ? 'denied' : 'pending';
  }
}
