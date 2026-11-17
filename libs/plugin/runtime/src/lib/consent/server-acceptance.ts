import { PluginGrantStatus, riskCovers, type RiskLevel } from '@bge/database';
import { resolveLocalizedStringDetailed, type NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentManifestSource } from './consent-classification.types';
import type {
  ConsentActDecision,
  ConsentActPresentation,
  ConsentActPresentationCheck,
} from './plugin-consent-act.types';

export interface ServerAcceptanceInput {
  /** The server-scope requested permissions this acceptance grants, in manifest order. */
  readonly accepted: readonly NormalizedPermissionRequest[];
  /** Every server-scope requested permission of the manifest shown, in manifest order. */
  readonly shown: readonly NormalizedPermissionRequest[];
  readonly riskOf: (check: NormalizedPermissionRequest) => RiskLevel;
  readonly source: ConsentManifestSource;
  readonly locale: string;
  readonly defaultLocale: string;
}

export interface ServerAcceptance {
  /** Consent decisions to write, sorted by permissionSlug ascending (the lock order). */
  readonly decisions: readonly ConsentActDecision[];
  readonly presentation: ConsentActPresentation;
}

/**
 * What a server admin was shown and accepted by installing or approving
 * (#1336): the `Granted` consent decisions the acceptance writes, and the
 * act's record of every server-scope requested permission on show. Pure, and
 * shaped like `planConsentAct`'s plan, so an act written by install or
 * approval reads like one written by a toggle.
 *
 * Installing or approving is an acceptance, never a refusal, so a requested
 * permission on show that the acceptance does not grant reads `unanswered`.
 */
export function planServerAcceptance(input: ServerAcceptanceInput): ServerAcceptance {
  const acceptedSlugs = new Set(input.accepted.map((check) => check.canonicalSlug));

  const decisions: ConsentActDecision[] = input.accepted
    .map((check) => ({
      permissionSlug: check.canonicalSlug,
      status: PluginGrantStatus.Granted,
      decidedRiskLevel: input.riskOf(check),
    }))
    // Code-unit order, not locale order: this is a lock order every process must agree on.
    .sort((a, b) => (a.permissionSlug < b.permissionSlug ? -1 : a.permissionSlug > b.permissionSlug ? 1 : 0));

  const checks = input.shown.map((check): ConsentActPresentationCheck => {
    const resolved = resolveLocalizedStringDetailed(check.reason, {
      locale: input.locale,
      defaultLocale: input.defaultLocale,
    });

    return {
      slug: check.canonicalSlug,
      required: check.required,
      feature: check.feature ?? null,
      riskLevel: input.riskOf(check),
      reason: resolved.value,
      usedFallback: resolved.usedFallback,
      outcome: acceptedSlugs.has(check.canonicalSlug) ? 'granted' : 'unanswered',
    };
  });

  return { decisions, presentation: { locale: input.locale, source: input.source, checks } };
}

/** One of the Server unit's consent decisions, as the approval rule reads it. */
export interface ServerApprovalDecision {
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
  readonly decidedRiskLevel: RiskLevel;
}

export interface ServerApprovalInput {
  /** Every requested permission of the staged manifest, in manifest order; the rule reads the server-scope ones. */
  readonly requested: readonly NormalizedPermissionRequest[];
  /** The Server unit's consent decisions on record for the plugin. */
  readonly decisions: readonly ServerApprovalDecision[];
  /** Today's catalog risk of a requested permission. */
  readonly riskOf: (check: NormalizedPermissionRequest) => RiskLevel;
}

export interface ServerApproval {
  /** What approving grants at today's risk, in manifest order: every required permission and every undecided optional one. */
  readonly accepted: readonly NormalizedPermissionRequest[];
  /**
   * The part of `accepted` that confers authority the Server unit does not
   * hold today: no decision, a denial, or a grant at a risk that no longer
   * covers today's. The Critical second factor is asked of these.
   */
  readonly newlyConferred: readonly NormalizedPermissionRequest[];
}

/**
 * What approving a staged update grants for the Server unit (#1336). Pure, so
 * the one rule is applied before the transaction, for the Critical second
 * factor, and again inside it against the decisions read under the plugin
 * row's lock.
 *
 * The server admin who approves a version that requires a permission consents
 * to it, so every required server-scope permission is accepted, a denied one
 * included. An optional one is accepted only when the Server unit has not
 * decided it: an existing optional decision is left as it stands, a denial or
 * a grant at a risk that has since risen, and a toggle or review act answers it.
 */
export function planServerApproval(input: ServerApprovalInput): ServerApproval {
  const decided = new Map(input.decisions.map((decision) => [decision.permissionSlug, decision]));

  const accepted = input.requested.filter(
    (check) => check.consentScope === 'server' && (check.required || !decided.has(check.canonicalSlug)),
  );

  const newlyConferred = accepted.filter((check) => {
    const decision = decided.get(check.canonicalSlug);

    return (
      decision === undefined ||
      decision.status !== PluginGrantStatus.Granted ||
      !riskCovers(decision.decidedRiskLevel, input.riskOf(check))
    );
  });

  return { accepted, newlyConferred };
}
