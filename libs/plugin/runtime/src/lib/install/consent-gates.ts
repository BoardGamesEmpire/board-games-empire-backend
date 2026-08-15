import { hasBoundingConditions, RiskLevel, type Permission } from '@bge/database';
import {
  parsePluginPermissionSlug,
  type NormalizedPermissionRequest,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { isPluginAdministrationSlug } from '../grants/plugin-admin-permissions';
import type { StaticAnalysisFinding } from './static-analysis.types';

/**
 * The consent-gate rules the installer (#59 C2) and the update service
 * (#59 C3) must apply IDENTICALLY — extracted the moment the second
 * consumer arrived, because these are security invariants and two drifting
 * copies of a security invariant is how version 2 becomes the smuggling
 * path version 1 could not be.
 *
 * Pure data-in/data-out: each helper reports violations or expectations and
 * the caller maps them to its own domain error (`PluginInstall*` vs
 * `PluginUpdate*`), so the shared logic stays free of both error domains.
 */

export interface ForbiddenPermissionViolation {
  readonly permissionSlug: string;
  readonly detail: string;
}

/**
 * Categorical exclusions on the manifest's permission surface (D-Z/D-W):
 * plugin-administration authority requested as a core check, a declared
 * bare slug that mimics the administration vocabulary, or a declared slug
 * claiming the `'all'` subject. Pattern-based on purpose — the refusal must
 * not depend on the C4 seed rows existing.
 */
export const collectForbiddenPermissionViolations = (
  validated: PluginManifestValidationResult,
): readonly ForbiddenPermissionViolation[] => {
  const violations: ForbiddenPermissionViolation[] = [];

  for (const check of validated.permissionChecks) {
    if (check.origin === 'core' && isPluginAdministrationSlug(check.canonicalSlug)) {
      violations.push({
        permissionSlug: check.canonicalSlug,
        detail: 'is plugin-administration authority — granted to a plugin it is a self-escalation loop',
      });
    }
  }

  for (const declared of validated.declaredPermissions) {
    const parsed = parsePluginPermissionSlug(declared.canonicalSlug);

    if (isPluginAdministrationSlug(parsed.bareSlug)) {
      violations.push({
        permissionSlug: declared.canonicalSlug,
        detail: 'mimics the plugin-administration vocabulary — the hard exclusion applies to the bare form',
      });
    }

    if (parsed.subjectPath === 'all' || parsed.subjectPath.startsWith('all:')) {
      violations.push({
        permissionSlug: declared.canonicalSlug,
        detail: "claims the 'all' subject — a naive CASL mapping would read it as wildcard authority",
      });
    }
  }

  return violations;
};

/**
 * Wildcard-subject exclusion on the CORE side, resolvable only once the
 * `Permission` rows are loaded: a core check whose seeded row carries the
 * `'all'` subject is never grantable to a plugin (the same rule
 * `AbilityFactory` applies to direct assignment).
 */
export const collectWildcardSubjectViolations = (
  validated: PluginManifestValidationResult,
  corePermissions: ReadonlyMap<string, Permission>,
): readonly ForbiddenPermissionViolation[] => {
  const violations: ForbiddenPermissionViolation[] = [];

  for (const check of validated.permissionChecks) {
    if (check.origin !== 'core') {
      continue;
    }

    if (corePermissions.get(check.canonicalSlug)?.subject === 'all') {
      violations.push({
        permissionSlug: check.canonicalSlug,
        detail:
          "carries the wildcard 'all' subject — never grantable to a plugin, same rule AbilityFactory applies to direct assignment",
      });
    }
  }

  return violations;
};

/**
 * Unit-boundedness on the CORE side (#60), resolvable only once the
 * `Permission` rows are loaded: a core check consented at household/user
 * scope must name a row that carries SOME bounding clause. A condition-free
 * row is subject-wide authority — nothing a unit consents to can bound
 * subject-wide reach to its own slice, so the read path refuses to confer
 * such grants and `decide()` refuses to record them. A manifest declaring
 * one would create a consent surface that is undecidable by design, and
 * the install must not create it.
 */
export const collectUnboundedUnitConsentViolations = (
  validated: PluginManifestValidationResult,
  corePermissions: ReadonlyMap<string, Permission>,
): readonly ForbiddenPermissionViolation[] => {
  const violations: ForbiddenPermissionViolation[] = [];

  for (const check of validated.permissionChecks) {
    if (check.origin !== 'core' || check.consentScope === 'server') {
      continue;
    }

    const permission = corePermissions.get(check.canonicalSlug);

    if (permission !== undefined && !hasBoundingConditions(permission.conditions)) {
      violations.push({
        permissionSlug: check.canonicalSlug,
        detail:
          `is condition-free but consented at ${check.consentScope} scope — nothing bounds the conferred ` +
          'authority to the consenting unit; request it at server scope or seed a unit-conditioned variant',
      });
    }
  }

  return violations;
};

/**
 * The Critical second-factor expectation (D-AE/D-AI): the sorted Critical
 * slugs among the server-consentable core checks that the calling pipeline
 * is about to GRANT. Plugin-declared permissions never qualify — their
 * rows are locked to an explicit `Low` (D-W).
 */
export const criticalConfirmationExpectation = (
  checksToGrant: readonly NormalizedPermissionRequest[],
  corePermissions: ReadonlyMap<string, Permission>,
): readonly string[] =>
  checksToGrant
    .filter(
      (check) => check.origin === 'core' && corePermissions.get(check.canonicalSlug)?.riskLevel === RiskLevel.Critical,
    )
    .map((check) => check.canonicalSlug)
    .sort();

export interface ExactReentryComparison {
  readonly expected: readonly string[];
  readonly received: readonly string[];
  readonly exact: boolean;
}

/** EXACT re-entry: every expected entry present, nothing else — set equality on distinct, sorted values. */
export const compareExactReentry = (
  expected: readonly string[],
  received: readonly string[],
): ExactReentryComparison => {
  const expectedSorted = [...new Set(expected)].sort();
  const receivedSorted = [...new Set(received)].sort();
  const exact =
    expectedSorted.length === receivedSorted.length &&
    expectedSorted.every((slug, index) => slug === receivedSorted[index]);

  return { expected: expectedSorted, received: receivedSorted, exact };
};

export interface ForbiddenAcknowledgementResolution {
  /** Distinct forbidden specifiers analysis reported, sorted. */
  readonly reported: readonly string[];
  /** Reported specifiers the acceptance did not name — outstanding consent. */
  readonly unacknowledged: readonly string[];
  /** Accepted specifiers analysis did not report — caller and server disagree about state. */
  readonly unexpected: readonly string[];
}

/**
 * Resolve the static-analysis gate against an admin's acceptance (D-AJ).
 * Keyed on the SPECIFIER, not the finding: `axios` imported from nine files
 * is one decision, and per-specifier (rather than a blanket flag) means a
 * NEW violation in a later version cannot ride an old acceptance.
 */
export const resolveForbiddenSpecifierAcknowledgement = (
  gating: readonly StaticAnalysisFinding[],
  acknowledged: readonly string[],
): ForbiddenAcknowledgementResolution => {
  // Forbidden findings always carry a specifier (only the unscreenable
  // kinds are specifier-less, and those are warnings), so the filter is a
  // type narrowing rather than a behavioral one.
  const reported = [
    ...new Set(
      gating.map((finding) => finding.specifier).filter((specifier): specifier is string => specifier !== null),
    ),
  ].sort();
  const received = [...new Set(acknowledged)].sort();

  return {
    reported,
    unacknowledged: reported.filter((specifier) => !received.includes(specifier)),
    unexpected: received.filter((specifier) => !reported.includes(specifier)),
  };
};
