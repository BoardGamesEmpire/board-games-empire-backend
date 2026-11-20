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

  /** The risk the consent surface showed for this requested permission. */
  readonly riskLevel: RiskLevel;

  readonly status: PluginGrantStatus;
}

/**
 * The risk a server admin's install or approval read showed for one
 * server-scope requested permission (#1336), sent back with the install or
 * approval as a toggle's answer sends its own.
 */
export interface ShownRisk {
  /** Canonical slug. */
  readonly permissionSlug: string;

  readonly riskLevel: RiskLevel;
}

/**
 * A type alias rather than an interface, here and in `ConsentActPresentation`:
 * an alias is assignable to Prisma's JSON input type, so the compiler checks
 * that what `writeConsentAct` stores is JSON (#1321).
 */
export type ConsentActPresentationCheck = {
  readonly feature: string | null;
  readonly outcome: 'granted' | 'refused' | 'unanswered';
  readonly reason: string;
  readonly required: boolean;
  readonly riskLevel: RiskLevel | null;
  readonly slug: string;
  readonly usedFallback: boolean;
};

/**
 * Stored verbatim in `PluginConsentAct.presentation`: every requested
 * permission the unit itself decides under the manifest the act named.
 */
export type ConsentActPresentation = {
  /** Manifest order. */
  readonly checks: readonly ConsentActPresentationCheck[];

  readonly locale: string;

  /** Which manifest the act's sha named: the installed one or the staged update. */
  readonly source: ConsentManifestSource;
};

export interface ConsentActDecision {
  readonly decidedRiskLevel: RiskLevel;
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
}

export interface ConsentActPlan {
  /** Consent decisions to write, sorted by permissionSlug ascending (the lock order). */
  readonly decisions: readonly ConsentActDecision[];

  readonly presentation: ConsentActPresentation;

  /** A review refused a required permission, so the unit is switched off in the same transaction. */
  readonly switchesOff: boolean;
}
