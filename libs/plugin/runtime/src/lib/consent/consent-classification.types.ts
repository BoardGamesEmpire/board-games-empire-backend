import { assertNeverPluginUnit, type PluginUnit } from '@bge/actor-context';
import type { RiskLevel } from '@bge/database';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';

/**
 * Consent-classification vocabulary shared by the classifier, feature-state
 * derivation, and the consent presentation (#60). Types plus the two scope
 * predicates — the same dependency-light shape as
 * `static-analysis.types.ts`/`update-escalation.types.ts`.
 */

/**
 * Is this consent scope the UNIT'S OWN to decide? Exact axis match — a
 * Household unit decides household-consented checks and nothing else; the
 * Server unit decides server-consented checks.
 */
export const unitOwnsConsentScope = (consentScope: PluginConsentScopeValue, unit: PluginUnit): boolean => {
  switch (unit.scopeType) {
    case 'Server':
      return consentScope === 'server';
    case 'Household':
      return consentScope === 'household';
    case 'User':
      return consentScope === 'user';
    default:
      return assertNeverPluginUnit(unit);
  }
};

/**
 * Which consent scopes this unit's resolution consumes — and therefore which
 * decisions are ADDRESSABLE from its coordinates (mirroring the ability read
 * path's grant scoping, `grantScopeCoordinatesForUnit` — #60): server-consented checks apply to
 * every unit, plus the checks the unit's own scope decides. A check owned by
 * a DIFFERENT unit axis never enters this unit's resolution, and no single
 * decision state exists for it from this viewpoint — each unit of that axis
 * decides for itself.
 */
export const unitConsumesConsentScope = (consentScope: PluginConsentScopeValue, unit: PluginUnit): boolean =>
  consentScope === 'server' || unitOwnsConsentScope(consentScope, unit);

/**
 * A consent decision as the unit experiences it: `denied` is a durable
 * refusal at the deciding scope; `pending` is a decision nobody has made —
 * which includes a `Granted` row that no longer confers (stale risk,
 * wildcard-subject drift, vanished catalog row), since the decision must be made
 * again before it means anything.
 */
export type ConsentCheckDecision = 'granted' | 'denied' | 'pending';

export interface ClassifiedConsentCheck {
  readonly decision: ConsentCheckDecision;
  /** Risk recorded on the deciding row — `Granted` or `Denied`; `null` when no row exists. */
  readonly decidedRiskLevel: RiskLevel | null;
  /** A `Granted` row exists but its `decidedRiskLevel` no longer covers today's risk (#59): reported pending, re-consent re-stamps. */
  readonly staleRisk: boolean;
}

export interface ConsentCheckClassification {
  /**
   * Keyed by canonical slug; ONLY unit-addressable checks appear
   * (`unitConsumesConsentScope`). A check absent here is decided per-unit on
   * another axis — the classifier refuses to answer for a decision these
   * coordinates cannot address, rather than reporting a false `pending`.
   */
  readonly decisions: ReadonlyMap<string, ClassifiedConsentCheck>;
  /**
   * Today's catalog risk for EVERY input check, addressable or not — the
   * presentation surface shows risk for checks other principals decide.
   * Absent = no catalog row.
   */
  readonly currentRiskBySlug: ReadonlyMap<string, RiskLevel>;
}
