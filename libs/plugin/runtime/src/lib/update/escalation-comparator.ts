import { PluginGrantScope, PluginGrantStatus, requestedByManifest, riskCovers, type RiskLevel } from '@bge/database';
import { requestedPermissionsOf } from '../manifest/active-manifest';
import type {
  GrantComparisonView,
  ManifestComparisonView,
  UpdateEscalation,
  UpdateEscalationComparison,
} from './update-escalation.types';

export interface EscalationComparatorInput {
  readonly active: ManifestComparisonView;
  /**
   * TODAY's catalog risk per canonical slug in the NEXT manifest — core
   * slugs from `Permission`, plugin-declared slugs locked `Low`.
   */
  readonly currentRiskBySlug: ReadonlyMap<string, RiskLevel>;
  /** Every existing `PluginGrant` row for the plugin, all scopes. */
  readonly grants: readonly GrantComparisonView[];
  readonly next: ManifestComparisonView;
}

/**
 * The update-escalation comparison (#59 Phase C3). Pure and synchronous:
 * the service prepares the views, this decides what escalated, whether the
 * server admin must approve, which denied permissions the update requires, and
 * which slugs activation tells household and user units they owe re-consent on
 * (#1149).
 *
 * Set semantics throughout — removal of a permission, a domain, or a
 * writesCore entry never escalates (narrowings are free), and the
 * `'configured'` transitions are asymmetric: list → `'configured'`
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
      // A scope change subsumes a simultaneous required promotion: the move
      // carries `required` itself, and a required move already routes the
      // new scope's re-consent, so reporting the promotion too would
      // double-count one decision. A decision kept at the new scope from an
      // earlier manifest that requested it there counts again, with no act
      // (#1152).
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

  // Risk escalation: only decisions that EXIST can be escalated against, and
  // only where the next manifest requests the permission at the decision's
  // own scope, by the manifest bound the ability read applies
  // (`requestedByManifest`, #577). Activation keeps every consent decision
  // (#1152), so a decision on a permission the next manifest does not
  // request, or requests at another scope, is kept, confers nothing while
  // that holds, and escalates nothing: routing it would ask re-consent of
  // units that do not decide it and cannot come to decide it, since a consent
  // act answers only the permissions its unit's consent scope owns (#1150,
  // #1336), and a Server decision there would gate approval on a permission
  // approval does not write.
  //
  // A permission that moved scope is bound the same way at its new scope: a
  // decision there, kept from an earlier manifest that requested it there or
  // given as a pre-consent, counts again on activation, so a stale one
  // escalates here. A move asks the new scope's units only when the
  // permission is required, so an optional move leaves this the only thing
  // that tells a unit holding the stale decision (#1152); a required move
  // names the permission in its re-consent list once, however many
  // escalations it raises.
  const requestedByNext = requestedByManifest(requestedPermissionsOf(input.next.checks));

  for (const grant of input.grants) {
    if (!requestedByNext(grant)) {
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

  const deniedRequiredSlugs = deniedRequiredServerSlugs(input.next.checks, input.grants);
  const nextRequiredSlugs = new Set(
    input.next.checks.filter((check) => check.required).map((check) => check.canonicalSlug),
  );

  const serverGating =
    deniedRequiredSlugs.length > 0 ||
    escalations.some(
      (escalation) =>
        (escalation.kind === 'new-permission' && escalation.consentScope === 'server') ||
        (escalation.kind === 'consent-scope-changed' && escalation.to === 'server') ||
        // Only a SERVER-scope decision's risk escalation is the server admin's
        // to re-approve; a household's stale consent is the household's. And
        // only on a permission the next manifest requires, the one kind
        // approval re-writes at today's risk (#1336). Approval leaves an
        // optional one as it stands, so gating on it would gate every later
        // update until a review act answers it, while it confers nothing in
        // the meantime: a decision whose risk no longer covers today's fails
        // closed when the plugin's abilities are read.
        (escalation.kind === 'risk-escalated' &&
          escalation.scopeType === PluginGrantScope.Server &&
          nextRequiredSlugs.has(escalation.slug)) ||
        escalation.kind === 'outbound-domain-added' ||
        escalation.kind === 'outbound-domains-configured' ||
        escalation.kind === 'writes-core-added',
    );

  const householdReconsentSlugs: string[] = [];
  const serverRiskEscalatedSlugs: string[] = [];
  const userReconsentSlugs: string[] = [];

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

    // Full household parity (#225): user-scope units re-consent on the same
    // four transitions household units do. Risk escalation qualifies
    // regardless of `required` — consent given for a Low permission is not
    // consent for the Critical one it became.
    if (
      (escalation.kind === 'new-permission' && escalation.consentScope === 'user' && escalation.required) ||
      (escalation.kind === 'permission-promoted-to-required' && escalation.consentScope === 'user') ||
      (escalation.kind === 'consent-scope-changed' && escalation.to === 'user' && escalation.required) ||
      (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.User)
    ) {
      userReconsentSlugs.push(escalation.slug);
      continue;
    }

    if (escalation.kind === 'risk-escalated' && escalation.scopeType === PluginGrantScope.Server) {
      serverRiskEscalatedSlugs.push(escalation.slug);
    }
  }

  // One permission can raise more than one escalation: a re-requested one is
  // new and its kept decision's risk escalated (#1152), a promoted one can
  // have escalated too, and every unit holding a stale decision on it
  // escalates. Each list names a permission once, where it first appeared.
  return {
    escalations,
    serverGating,
    deniedRequiredSlugs,
    householdReconsentSlugs: [...new Set(householdReconsentSlugs)],
    serverRiskEscalatedSlugs: [...new Set(serverRiskEscalatedSlugs)],
    userReconsentSlugs: [...new Set(userReconsentSlugs)],
  };
};

/**
 * The server-scope permissions the next manifest requires that the Server unit
 * has denied, in manifest order (#1336). Approving the update grants them, so
 * only a server admin's approval may activate it, never an immediate
 * activation. Keyed on next's required set, not on escalations: the denial may
 * predate the update entirely. The comparison gates on this, and activation
 * asks it again of the decisions it reads under the plugin row's claim.
 */
export const deniedRequiredServerSlugs = (
  nextChecks: ManifestComparisonView['checks'],
  grants: readonly Pick<GrantComparisonView, 'permissionSlug' | 'scopeType' | 'status'>[],
): string[] => {
  const deniedServerSlugs = new Set(
    grants
      .filter((grant) => grant.scopeType === PluginGrantScope.Server && grant.status === PluginGrantStatus.Denied)
      .map((grant) => grant.permissionSlug),
  );

  return nextChecks
    .filter((check) => check.consentScope === 'server' && check.required && deniedServerSlugs.has(check.canonicalSlug))
    .map((check) => check.canonicalSlug);
};

const compareOutboundDomains = (
  active: readonly string[] | 'configured',
  next: readonly string[] | 'configured',
): UpdateEscalation[] => {
  if (next === 'configured') {
    // 'configured' → 'configured' is no change; list → 'configured' is the
    // broadening.
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
