import type { PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';

/**
 * Escalation vocabulary for the update comparison (#59 Phase C3).
 * Types only — `plugin.events.ts` carries these on the update-pending
 * payload, and the comparator produces them — so the shapes live in a
 * dependency-light file the same way `static-analysis.types.ts` does.
 */

export type UpdateEscalation =
  /** The next manifest requests a permission the active one does not. */
  | {
      readonly kind: 'new-permission';
      readonly slug: string;
      readonly consentScope: PluginConsentScopeValue;
      readonly required: boolean;
    }
  /** A permission requested by both versions flips `required: false → true`. */
  | {
      readonly kind: 'permission-promoted-to-required';
      readonly slug: string;
      readonly consentScope: PluginConsentScopeValue;
    }
  /**
   * A permission with an existing consent decision now carries a HIGHER
   * catalog risk than the one shown when the unit decided — the stored
   * `decidedRiskLevel` is the comparison baseline, never a reconstruction.
   */
  | {
      readonly kind: 'risk-escalated';
      readonly slug: string;
      readonly scopeType: PluginGrantScope;
      readonly decidedRiskLevel: RiskLevel;
      readonly currentRiskLevel: RiskLevel;
    }
  /** A domain joins `network.outboundDomains`. */
  | { readonly kind: 'outbound-domain-added'; readonly domain: string }
  /**
   * `network.outboundDomains` moves from an explicit list to the literal
   * `'configured'` — a BROADENING: reach delegates from an enumerated
   * set to whatever the runtime SafeHttp policy permits. The reverse
   * transition is a narrowing and produces nothing.
   */
  | { readonly kind: 'outbound-domains-configured' }
  /**
   * A permission requested by both versions changed which unit consents to
   * it. Not a widening or a narrowing but a DIFFERENT consent act: the
   * decision on record was made by a principal that no longer owns it, so
   * the permission must be consented afresh at `to` and the grant at `from`
   * has nothing left to authorize.
   */
  | {
      readonly kind: 'consent-scope-changed';
      readonly slug: string;
      readonly from: PluginConsentScopeValue;
      readonly to: PluginConsentScopeValue;
      readonly required: boolean;
    }
  /** A core model joins `storage.writesCore`. */
  | { readonly kind: 'writes-core-added'; readonly model: string };

/** The comparator's view of one manifest version — prepared by the update service from a validation result. */
export interface ManifestComparisonView {
  readonly outboundDomains: readonly string[] | 'configured';
  readonly writesCore: readonly string[];
  readonly checks: readonly {
    readonly canonicalSlug: string;
    readonly consentScope: PluginConsentScopeValue;
    readonly required: boolean;
  }[];
}

/** One existing grant row, reduced to the fields the comparison consumes. */
export interface GrantComparisonView {
  readonly permissionSlug: string;
  readonly scopeType: PluginGrantScope;
  readonly status: PluginGrantStatus;
  readonly decidedRiskLevel: RiskLevel;
}

export interface UpdateEscalationComparison {
  readonly escalations: readonly UpdateEscalation[];
  /**
   * True when activation needs the server admin's explicit approval: a new
   * server-consentable permission, a permission moving TO server consent, a
   * risk escalation on a SERVER-scope decision, an outbound-domain
   * broadening, or a `writesCore` addition.
   *
   * Escalations belonging to a unit deliberately do NOT server-gate — their
   * consent is not the server admin's to give, and gating on them
   * would both ask the wrong principal and stall the update on a decision
   * that principal cannot make. Activation expresses those as per-unit
   * suspension instead.
   */
  readonly serverGating: boolean;
  /**
   * Server-scope `Denied` rows on permissions the next manifest marks
   * required. Non-empty BLOCKS activation entirely — staging is
   * still permitted, approval is refused until the denial is reversed.
   */
  readonly blockedByDenial: readonly string[];
  /**
   * Household-scope slugs a unit must decide again before it may keep
   * serving: newly required, promoted to required, risk-escalated above the
   * risk the unit consented under, or newly moved to household
   * consent. On activation every household unit lacking a `Granted` row for
   * all of these is suspended until late acceptance re-enables it, which
   * re-stamps the decision at today's risk (#59).
   *
   * Named for re-consent rather than for `required` because risk escalation
   * qualifies regardless of the flag: consent given for a Low permission is
   * not consent for the Critical one it became.
   */
  readonly householdReconsentSlugs: readonly string[];
  /**
   * Server-scope slugs whose catalog risk now exceeds the risk recorded on
   * their grant. Approval re-stamps these (approval IS that consent act),
   * and any that reach `Critical` join the second-factor expectation —
   * without the re-stamp the same escalation would re-fire on every future
   * update and the second factor would never see it.
   */
  readonly serverRiskEscalatedSlugs: readonly string[];
  /**
   * User-scope slugs a user must decide again before their unit may keep
   * serving — the exact user-scope mirror of `householdReconsentSlugs`
   * (#225): newly required, promoted to required, risk-escalated above the
   * risk the user consented under, or newly moved to user consent. On
   * activation every `UserPlugin` unit lacking a covering `Granted` row for
   * all of these is suspended until late acceptance re-enables it. Users
   * with no enablement row are unaffected — no row means not
   * enabled, so there is nothing to suspend.
   */
  readonly userReconsentSlugs: readonly string[];
}
