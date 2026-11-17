import { PluginGrantStatus, type RiskLevel } from '@bge/database';
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
