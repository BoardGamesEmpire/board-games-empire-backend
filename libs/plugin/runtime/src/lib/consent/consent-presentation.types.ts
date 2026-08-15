import type { PluginUnit } from '@bge/actor-context';
import type { RiskLevel } from '@bge/database';
import type {
  PermissionCheckOrigin,
  PluginConsentScopeValue,
  ResolvedLocalizedString,
} from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckDecision } from './consent-classification.types';

/**
 * The decision state of one check as seen from the presented unit: the
 * classifier's addressable states (the deciding row is the Server sentinel
 * or the unit's own coordinates), plus `per-unit` for a check decided on a
 * DIFFERENT unit axis — each unit of that axis decides for itself, so no
 * single state exists from this viewpoint and reporting `pending` would be
 * false the moment any such unit has decided.
 */
export type PluginCheckDecisionState = ConsentCheckDecision | 'per-unit';

/** One manifest check, enriched for a consent surface (#60). */
export interface PluginCheckPresentation {
  /** Canonical slug: the `plugin|<slug>|<bare>` envelope for own-namespace checks, the core slug otherwise. */
  readonly slug: string;
  readonly origin: PermissionCheckOrigin;
  readonly required: boolean;
  readonly consentScope: PluginConsentScopeValue;
  /** Manifest `features[].name` the check is bound to; `null` for plugin-wide checks. */
  readonly feature: string | null;
  /** True when the presented unit is the principal that decides this check (exact scope-axis match). */
  readonly decidableByUnit: boolean;
  readonly decision: PluginCheckDecisionState;
  /**
   * Today's catalog risk. For an own-namespace check whose `PluginPermission`
   * row does not exist yet (a pending update's new declare), this is the
   * locked `Low` every plugin-declared row carries (#59) — the row
   * activation creates can hold nothing else. A
   * CORE check with no catalog row is `null`: the risk is unknowable and a
   * grant over it confers nothing.
   */
  readonly riskLevel: RiskLevel | null;
  /** Risk recorded on the addressable deciding row (`Granted` or `Denied`); `null` when no row exists or the decision is per-unit. */
  readonly decidedRiskLevel: RiskLevel | null;
  /**
   * A `Granted` row exists whose `decidedRiskLevel` no longer covers today's
   * risk (#59): `decision` reports `pending` — the consent on record was
   * given for a different classification — and re-consent re-stamps it.
   */
  readonly staleRisk: boolean;
  /** The author's justification, localized per the requested locale with fallback provenance. */
  readonly reason: ResolvedLocalizedString;
}

/** One manifest `features[]` declaration, localized — the grouping context for checks carrying its name. */
export interface PluginFeaturePresentation {
  readonly name: string;
  readonly displayName: ResolvedLocalizedString;
  readonly description: ResolvedLocalizedString;
}

/**
 * A plugin's consent surface assembled for one unit and locale — the
 * enrichment the C4 install/update responses and consent screens render
 * (#60). Checks appear in manifest order, EVERY check the manifest
 * requests: transparency about what the plugin wants is the point, and
 * `decidableByUnit`/`decision` tell the renderer which rows are this
 * principal's to act on. `features` carries the manifest's localized
 * feature declarations so a renderer can group checks by feature without a
 * second lookup — for a pending manifest these are the STAGED version's
 * features, which no other surface can provide.
 */
export interface PluginConsentPresentation {
  readonly plugin: {
    readonly id: string;
    readonly slug: string;
    /**
     * The kill switch, surfaced for context only: consent is decidable while
     * a plugin is disabled (`enabled` gates when consent is ACTIONABLE, not
     * whether it can be given), so presentation does not gate on it either.
     */
    readonly enabled: boolean;
  };
  /** Version of the manifest whose checks are presented — the pending version when `source` is `'pending'`. */
  readonly manifestVersion: string;
  /** Which stored manifest the surface came from: the active version or a staged update awaiting approval. */
  readonly source: 'active' | 'pending';
  readonly unit: PluginUnit;
  readonly displayName: ResolvedLocalizedString;
  readonly description: ResolvedLocalizedString;
  readonly features: readonly PluginFeaturePresentation[];
  readonly checks: readonly PluginCheckPresentation[];
}
