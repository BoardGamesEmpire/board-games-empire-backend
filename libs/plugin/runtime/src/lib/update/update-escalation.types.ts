import type { PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import type { PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';

/**
 * Escalation vocabulary for the update comparison (#59 Phase C3).
 * Types only — `plugin.events.ts` carries these on the update-pending
 * payload, and the comparator produces them — so the shapes live in a
 * dependency-light file the same way plugin-analysis's `static-analysis.types.ts` does.
 */

export type UpdateEscalation =
  /** The next manifest requests a permission the active one does not. */
  | {
      readonly consentScope: PluginConsentScopeValue;
      readonly kind: 'new-permission';
      readonly required: boolean;
      readonly slug: string;
    }
  /** A permission requested by both versions flips `required: false → true`. */
  | {
      readonly consentScope: PluginConsentScopeValue;
      readonly kind: 'permission-promoted-to-required';
      readonly slug: string;
    }
  /**
   * A permission with an existing consent decision now carries a HIGHER
   * catalog risk than the one shown when the unit decided — the stored
   * `decidedRiskLevel` is the comparison baseline, never a reconstruction.
   */
  | {
      readonly currentRiskLevel: RiskLevel;
      readonly decidedRiskLevel: RiskLevel;
      readonly kind: 'risk-escalated';
      readonly scopeType: PluginGrantScope;
      readonly slug: string;
    }
  /** A domain joins `network.outboundDomains`. */
  | { readonly domain: string; readonly kind: 'outbound-domain-added' }
  /**
   * `network.outboundDomains` moves from an explicit list to the literal
   * `'configured'` — a BROADENING: reach delegates from an enumerated
   * set to whatever the runtime SafeHttp policy permits. The reverse
   * transition is a narrowing and produces nothing.
   */
  | { readonly kind: 'outbound-domains-configured' }
  /**
   * A permission requested by both versions changed which unit consents to
   * it. Not a widening or a narrowing but a DIFFERENT consent act: a
   * decision at `from` was made by a consent unit at a scope that no longer
   * owns it, and it is kept and confers nothing while the permission is
   * requested at `to` (#1152). At `to` the permission is consented by that
   * scope's units, and a decision kept there from an earlier manifest that
   * requested it at `to` counts again, with no act.
   */
  | {
      readonly from: PluginConsentScopeValue;
      readonly kind: 'consent-scope-changed';
      readonly required: boolean;
      readonly slug: string;
      readonly to: PluginConsentScopeValue;
    }
  /** A core model joins `storage.writesCore`. */
  | { readonly kind: 'writes-core-added'; readonly model: string };

/** The comparator's view of one manifest version — prepared by the update service from a validation result. */
export interface ManifestComparisonView {
  readonly checks: readonly {
    readonly canonicalSlug: string;
    readonly consentScope: PluginConsentScopeValue;
    readonly required: boolean;
  }[];

  readonly outboundDomains: readonly string[] | 'configured';
  readonly writesCore: readonly string[];
}

/** One existing grant row, reduced to the fields the comparison consumes. */
export interface GrantComparisonView {
  readonly decidedRiskLevel: RiskLevel;
  readonly permissionSlug: string;
  readonly scopeType: PluginGrantScope;
  readonly status: PluginGrantStatus;
}

export interface UpdateEscalationComparison {
  /**
   * Server-scope `Denied` rows on permissions the next manifest marks
   * required. Non-empty gates the update on approval, and approving it grants
   * each of them at today's risk, under the approval's consent act (#1336):
   * the server admin who approves a version that requires a permission
   * consents to it.
   */
  readonly deniedRequiredSlugs: readonly string[];

  readonly escalations: readonly UpdateEscalation[];

  /**
   * Household-scope slugs a unit must decide again: newly required, promoted
   * to required, risk-escalated above the risk the unit consented under, or
   * newly moved to household consent. On activation every enabled household
   * unit lacking a covering `Granted` row for all of these is told it owes
   * re-consent and keeps running on its existing grants; its answer stamps
   * the decision at today's risk (#59, #1149).
   *
   * Named for re-consent rather than for `required` because risk escalation
   * qualifies regardless of the flag: consent given for a Low permission is
   * not consent for the Critical one it became.
   */
  readonly householdReconsentSlugs: readonly string[];

  /**
   * True when activation needs the server admin's explicit approval: a new
   * server-consentable permission, a permission moving TO server consent, a
   * risk escalation on a SERVER-scope decision on a permission the next
   * manifest requires (an optional one waits for a review act and confers
   * nothing until then, #1336), an outbound-domain
   * broadening, a `writesCore` addition, or a denied server-scope permission
   * the next manifest requires (`deniedRequiredSlugs`).
   *
   * Escalations belonging to a unit deliberately do NOT server-gate — their
   * consent is not the server admin's to give, and gating on them
   * would both ask the wrong principal and stall the update on a decision
   * that principal cannot make. Activation announces those to each unit as
   * re-consent it owes instead (#1149).
   */
  readonly serverGating: boolean;

  /**
   * Server-scope slugs whose catalog risk now exceeds the risk recorded on
   * their granted consent decision. Approval re-writes a required one at
   * today's risk, and one that reaches `Critical` joins what the Critical
   * confirmation expects. An optional one is left as it stands: approving
   * confers nothing through it, and a review act answers it (#1336).
   */
  readonly serverRiskEscalatedSlugs: readonly string[];

  /**
   * User-scope slugs a user must decide again — the exact user-scope mirror
   * of `householdReconsentSlugs` (#225): newly required, promoted to
   * required, risk-escalated above the risk the user consented under, or
   * newly moved to user consent. On activation every enabled `UserPlugin`
   * unit lacking a covering `Granted` row for all of these is told it owes
   * re-consent and keeps running on its existing grants (#1149). Users with
   * no unit enablement are unaffected — no row means not enabled, so there is
   * nobody to tell.
   */
  readonly userReconsentSlugs: readonly string[];
}
