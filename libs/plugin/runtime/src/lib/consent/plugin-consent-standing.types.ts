import type { RiskLevel } from '@bge/database';

/**
 * Consent-standing vocabulary (#1149): what a consent unit still owes a
 * plugin, worked out when read from its grants, the active manifest and
 * today's catalog risk. Nothing here is stored.
 */

/**
 * Why a check the unit's resolution consumes does not confer, in the order
 * the standing assigns it:
 * - `outstanding_elsewhere` — a check the unit consumes but does not own
 *   (a server-consented check seen from a household or user); only the
 *   owning scope can answer it.
 * - `refused` — a durable `Denied` decision at the deciding scope.
 * - `risk_raised` — a `Granted` row whose decided risk no longer covers
 *   today's catalog risk; consenting again re-stamps it.
 * - `never_asked` — every other non-conferring state: no row, a vanished
 *   catalog row, a subject drifted to the wildcard, a unit-binding refusal.
 */
export type ConsentOutstandingKind = 'never_asked' | 'refused' | 'risk_raised' | 'outstanding_elsewhere';

export interface ConsentOutstandingCheck {
  /** Manifest `features[].name` the check is bound to, or `null` for a plugin-wide check. */
  readonly feature: string | null;

  readonly kind: ConsentOutstandingKind;

  /** Localized reason text, resolved with the manifest fallback chain. */
  readonly reason: string;

  readonly required: boolean;

  /** Today's catalog risk; `null` when a core permission's catalog row is gone. A declared permission is always `Low`. */
  readonly riskLevel: RiskLevel | null;

  /** Canonical slug. */
  readonly slug: string;
}

export interface PluginConsentStanding {
  /** Optional checks the unit's resolution consumes that do not confer. */
  readonly optionalOff: readonly ConsentOutstandingCheck[];

  /** Required checks the unit's resolution consumes that do not confer. */
  readonly outstanding: readonly ConsentOutstandingCheck[];
}

/** The standing plus the detail feature state needs and the wire shape leaves out. */
export interface PluginConsentStandingDetail {
  /**
   * Slugs under `standing` that a durable `Denied` row blocks, at whichever
   * scope decides them. A server admin's refusal seen from a household is in
   * here while its kind reads `outstanding_elsewhere`.
   */
  readonly refusedSlugs: ReadonlySet<string>;

  readonly standing: PluginConsentStanding;
}
