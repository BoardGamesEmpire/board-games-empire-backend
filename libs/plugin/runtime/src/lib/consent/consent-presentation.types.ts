import type { PluginUnit } from '@bge/actor-context';
import type { RiskLevel } from '@bge/database';
import type {
  PermissionCheckOrigin,
  PluginConsentScopeValue,
  ResolvedLocalizedString,
} from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckDecision, ConsentManifestSource } from './consent-classification.types';

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
  readonly consentScope: PluginConsentScopeValue;
  /** True when the presented unit is the principal that decides this check (exact scope-axis match). */
  readonly decidableByUnit: boolean;
  /** Risk recorded on the addressable deciding row (`Granted` or `Denied`); `null` when no row exists or the decision is per-unit. */
  readonly decidedRiskLevel: RiskLevel | null;
  readonly decision: PluginCheckDecisionState;
  /** Manifest `features[].name` the check is bound to; `null` for plugin-wide checks. */
  readonly feature: string | null;
  /**
   * Whether consent at this requested permission's consent scope could ever
   * confer it (#1150). `true` for a permission another unit axis decides
   * (`per-unit`): this surface cannot judge another unit's binding.
   */
  readonly grantable: boolean;
  readonly origin: PermissionCheckOrigin;
  /** The author's justification, localized per the requested locale with fallback provenance. */
  readonly reason: ResolvedLocalizedString;
  readonly required: boolean;
  /**
   * Today's catalog risk. For an own-namespace check whose `PluginPermission`
   * row does not exist yet (a pending update's new declare), this is the
   * locked `Low` every plugin-declared row carries (#59) — the row
   * activation creates can hold nothing else. A
   * CORE check with no catalog row is `null`: the risk is unknowable and a
   * grant over it confers nothing.
   */
  readonly riskLevel: RiskLevel | null;
  /** Canonical slug: the `plugin|<slug>|<bare>` envelope for own-namespace checks, the core slug otherwise. */
  readonly slug: string;
  /**
   * Staged surface only: the active manifest does not request this permission
   * at this consent scope, so the only consent it can have is a pre-consent
   * to this staged update (#1150). Always `false` on the active surface.
   */
  readonly stagedOnly: boolean;
  /**
   * A `Granted` row exists whose `decidedRiskLevel` no longer covers today's
   * risk (#59): `decision` reports `pending` — the consent on record was
   * given for a different classification — and re-consent re-stamps it.
   */
  readonly staleRisk: boolean;
}

/** One manifest `features[]` declaration, localized — the grouping context for checks carrying its name. */
export interface PluginFeaturePresentation {
  readonly description: ResolvedLocalizedString;
  readonly displayName: ResolvedLocalizedString;
  readonly name: string;
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
  readonly checks: readonly PluginCheckPresentation[];
  readonly description: ResolvedLocalizedString;
  readonly displayName: ResolvedLocalizedString;
  readonly features: readonly PluginFeaturePresentation[];
  /**
   * The one server locale the surface was rendered in: the request's
   * resolved locale, a tag this server supports. A consent write sends it
   * back as its `locale`, so the act records the text that was read (#1301).
   * Each reason's own `locale` differs: it names the key of the plugin's text
   * the reason came from, which falls back when the plugin has none in this
   * locale.
   */
  readonly locale: string;
  /**
   * The artifact sha of the manifest presented: the installed artifact's on
   * the active surface, the staged artifact's on a staged surface. A consent
   * act names it, so consent is tied to what the unit was shown (#1150).
   */
  readonly manifestSha256: string;
  /** Version of the manifest whose checks are presented — the staged version when `source` is `'staged'`. */
  readonly manifestVersion: string;
  readonly plugin: {
    /**
     * The kill switch, surfaced for context only: consent is decidable while
     * a plugin is disabled (`enabled` gates when consent is ACTIONABLE, not
     * whether it can be given), so presentation does not gate on it either.
     */
    readonly enabled: boolean;
    readonly id: string;
    readonly slug: string;
  };
  /** Which stored manifest the surface came from: the active version or a staged update awaiting approval. */
  readonly source: ConsentManifestSource;
  /** On the active surface: the staged update a unit may pre-consent to, or null. Always null on a staged surface (#1150). */
  readonly stagedUpdate: { readonly manifestSha256: string; readonly manifestVersion: string } | null;
  readonly unit: PluginUnit;
}
