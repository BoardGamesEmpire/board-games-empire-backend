import type { HouseholdPluginUnit, UserPluginUnit } from '@bge/actor-context';
import type { PluginGrantStatus, RiskLevel } from '@bge/database';
import type { ConsentManifestSource } from './consent-classification.types';

/**
 * Vocabulary of a consent act (#1150): the one recorded step in which a
 * household or user switches a plugin on, toggles one optional permission, or
 * reviews what an update left outstanding, and in which a server admin toggles
 * or reviews for the Server unit. Types only, so the planner, the
 * transactional service and the HTTP edge can share them.
 */

/**
 * The units whose acts `PluginConsentActService` writes: a household or a
 * user. The Server unit's acts are written by `PluginServerConsentActService`.
 */
export type ConsentActUnit = HouseholdPluginUnit | UserPluginUnit;

export type ConsentActKind = 'SwitchOn' | 'Toggle' | 'Review';

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
  /** Which manifest the act's sha named: the installed one or the staged update. */
  readonly source: ConsentManifestSource;
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
