import type { HouseholdPluginUnit, UserPluginUnit } from '@bge/actor-context';
import type { PluginGrantStatus, RiskLevel } from '@bge/database';

/**
 * Vocabulary of a consent act (#1150): the one recorded step in which a
 * household or user switches a plugin on, toggles one optional permission, or
 * reviews what an update left outstanding. Types only, so the planner, the
 * transactional service and the HTTP edge can share them.
 */

/** The units that give consent themselves; the server unit consents by operator approval. */
export type ConsentActUnit = HouseholdPluginUnit | UserPluginUnit;

export type ConsentActKind = 'SwitchOn' | 'Toggle' | 'Review';

/** Which manifest the act's sha names: the installed one or the staged update. */
export type ConsentActSource = 'active' | 'pending';

export interface ConsentActAnswer {
  /** Canonical slug. */
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
  /** The risk the consent surface showed for this requested permission. */
  readonly riskLevel: RiskLevel;
}

export interface ConsentActPresentationCheck {
  readonly slug: string;
  readonly required: boolean;
  readonly feature: string | null;
  readonly riskLevel: RiskLevel | null;
  readonly reason: string;
  readonly usedFallback: boolean;
  readonly outcome: 'granted' | 'refused' | 'unanswered';
}

/**
 * Stored verbatim in `PluginConsentAct.presentation`: every requested
 * permission the unit itself decides under the manifest the act named.
 */
export interface ConsentActPresentation {
  readonly locale: string;
  readonly source: ConsentActSource;
  /** Manifest order. */
  readonly checks: readonly ConsentActPresentationCheck[];
}

export interface ConsentActDecision {
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
  readonly decidedRiskLevel: RiskLevel;
}

export interface ConsentActPlan {
  /** Consent decisions to write, sorted by permissionSlug ascending (the lock order). */
  readonly decisions: readonly ConsentActDecision[];
  /** A review refused a required permission, so the unit is switched off in the same transaction. */
  readonly switchesOff: boolean;
  readonly presentation: ConsentActPresentation;
}
