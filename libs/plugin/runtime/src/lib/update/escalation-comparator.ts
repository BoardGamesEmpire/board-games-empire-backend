import { PluginGrantScope, PluginGrantStatus, type RiskLevel } from '@bge/database';
import { riskCovers } from '../grants/risk-ordering';
import type {
  GrantComparisonView,
  ManifestComparisonView,
  UpdateEscalation,
  UpdateEscalationComparison,
} from './update-escalation.types';

// Re-exported so consumers reaching for the ordering alongside the
// comparison do not need a second import path.
export { riskCovers };

export interface EscalationComparatorInput {
  readonly active: ManifestComparisonView;
  readonly next: ManifestComparisonView;
  /** Every existing `PluginGrant` row for the plugin, all scopes. */
  readonly grants: readonly GrantComparisonView[];
  /**
   * TODAY's catalog risk per canonical slug in the NEXT manifest — core
   * slugs from `Permission`, plugin-declared slugs locked `Low` (D-W).
   */
  readonly currentRiskBySlug: ReadonlyMap<string, RiskLevel>;
}

/**
 * The update-escalation comparison (#59 Phase C3, D-AP). Pure and
 * synchronous: the service prepares the views, this decides what escalated,
 * whether the server admin must approve, what a surviving denial blocks
 * (D-AB), and which household units activation will suspend (D-AO).
 *
 * Set semantics throughout — removal of a permission, a domain, or a
 * writesCore entry never escalates (narrowings are free), and the
 * `'configured'` transitions follow D-AP exactly: list → `'configured'`
 * broadens and gates, `'configured'` → list narrows, `'configured'` →
 * `'configured'` is no change.
 *
 * Each escalation is routed to the principal who owns the decision: server
 * escalations gate approval, unit escalations become per-unit re-consent.
 * Gating the server admin on a household's stale consent would ask the
 * wrong principal and leave the household never asked.
 */
export const compareForEscalations = (input: EscalationComparatorInput): UpdateEscalationComparison => {
  const escalations: UpdateEscalation[] = [];
  const activeChecks = new Map(input.active.checks.map((check) => [check.canonicalSlug, check]));

  for (const check of input.next.checks) {
    const previous = activeChecks.get(check.canonicalSlug);

    if (previous === undefined) {
      escalations.push({
        kind: 'new-permission',
        slug: check.canonicalSlug,
        consentScope: check.consentScope,
        required: check.required,
      });
      continue;
    }

    if (check.consentScope !== previous.consentScope) {
      escalations.push({
        kind: 'consent-scope-changed',
        slug: check.canonicalSlug,
        from: previous.consentScope,
        to: check.consentScope,
        required: check.required,
      });
      // A scope change subsumes a simultaneous required promotion: the
      // permission has to be consented from scratch at the new scope, so
      // reporting the promotion too would double-count one decision.
      continue;
    }

    if (check.required && !previous.required) {
      escalations.push({
        kind: 'permission-promoted-to-required',
        slug: check.canonicalSlug,
        consentScope: check.consentScope,
      });
    }
  }

  // Risk escalation (D-X): only decisions that EXIST can be escalated
  // against, and only for permissions the next manifest still requests —
  // a grant on a dropped check is dormant, not escalated.
  const nextSlugs = new Set(input.next.checks.map((check) => check.canonicalSlug));

  for (const grant of input.grants) {
    if (!nextSlugs.has(grant.permissionSlug)) {
      continue;
    }

    // A Denied row confers no authority, so a risk reclassification on it
    // escalates nothing: there is no consent to re-take, nothing to gate
    // approval on, and re-stamping it would rewrite the provenance of
    // somebody's durable refusal.
    if (grant.status !== PluginGrantStatus.Granted) {
      continue;
    }

    const currentRiskLevel = input.currentRiskBySlug.get(grant.permissionSlug);

    if (currentRiskLevel !== undefined && !riskCovers(grant.decidedRiskLevel, currentRiskLevel)) {
      escalations.push({
        kind: 'risk-escalated',
        slug: grant.permissionSlug,
        scopeType: grant.scopeType,
        decidedRiskLevel: grant.decidedRiskLevel,
        currentRiskLevel,
      });
    }
  }

  escalations.push(...compareOutboundDomains(input.active.outboundDomains, input.next.outboundDomains));

  const activeWrites = new Set(input.active.writesCore);

  for (const model of input.next.writesCore) {
    if (!activeWrites.has(model)) {
      escalations.push({ kind: 'writes-core-added', model });
    }
  }

  const serverGating = escalations.some(
    (escalation) =>
      (escalation.kind === 'new-permission' && escalation.consentScope === 'server') ||
      (escalation.kind === 'consent-scope-changed' && escalation.to === 'server') ||
      // Only a SERVER-scope decision's risk escalation is the server admin's
      // to re-approve; a household's stale consent is the household's.
      (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.Server) ||
      escalation.kind === 'outbound-domain-added' ||
      escalation.kind === 'outbound-domains-configured' ||
      escalation.kind === 'writes-core-added',
  );

  // D-AB: a surviving Server-scope Denied row on a permission the NEXT
  // manifest marks required blocks activation — required means the plugin
  // cannot honestly run without it, and a durable refusal must not be
  // steamrolled by a version bump. Keyed on next's required set, not on
  // escalations: the denial may predate this update entirely.
  const deniedServerSlugs = new Set(
    input.grants
      .filter((grant) => grant.scopeType === PluginGrantScope.Server && grant.status === PluginGrantStatus.Denied)
      .map((grant) => grant.permissionSlug),
  );
  const blockedByDenial = input.next.checks
    .filter((check) => check.consentScope === 'server' && check.required && deniedServerSlugs.has(check.canonicalSlug))
    .map((check) => check.canonicalSlug);

  const householdReconsentSlugs: string[] = [];
  const serverRiskEscalatedSlugs: string[] = [];
  const userRiskEscalatedSlugs: string[] = [];

  for (const escalation of escalations) {
    if (
      (escalation.kind === 'new-permission' && escalation.consentScope === 'household' && escalation.required) ||
      (escalation.kind === 'permission-promoted-to-required' && escalation.consentScope === 'household') ||
      (escalation.kind === 'consent-scope-changed' && escalation.to === 'household' && escalation.required) ||
      (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.Household)
    ) {
      householdReconsentSlugs.push(escalation.slug);
      continue;
    }

    if (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.Server) {
      serverRiskEscalatedSlugs.push(escalation.slug);
      continue;
    }

    if (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.User) {
      userRiskEscalatedSlugs.push(escalation.slug);
    }
  }

  return {
    escalations,
    serverGating,
    blockedByDenial,
    householdReconsentSlugs,
    serverRiskEscalatedSlugs,
    userRiskEscalatedSlugs,
  };
};

const compareOutboundDomains = (
  active: readonly string[] | 'configured',
  next: readonly string[] | 'configured',
): UpdateEscalation[] => {
  if (next === 'configured') {
    // 'configured' → 'configured' is no change; list → 'configured' is the
    // D-AP broadening.
    return active === 'configured' ? [] : [{ kind: 'outbound-domains-configured' }];
  }

  if (active === 'configured') {
    // 'configured' → explicit list is a narrowing: the runtime policy could
    // already reach anything the list names.
    return [];
  }

  const known = new Set(active);

  return next.filter((domain) => !known.has(domain)).map((domain) => ({ kind: 'outbound-domain-added', domain }));
};
