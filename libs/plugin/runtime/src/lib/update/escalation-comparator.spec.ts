import { PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import { compareForEscalations, type EscalationComparatorInput } from './escalation-comparator';
import type { GrantComparisonView, ManifestComparisonView } from './update-escalation.types';

describe('compareForEscalations', () => {
  const check = (canonicalSlug: string, consentScope: 'server' | 'household' | 'user' = 'server', required = true) => ({
    canonicalSlug,
    consentScope,
    required,
  });

  const view = (overrides: Partial<ManifestComparisonView> = {}): ManifestComparisonView => ({
    outboundDomains: [],
    writesCore: [],
    checks: [],
    ...overrides,
  });

  const grant = (overrides: Partial<GrantComparisonView> = {}): GrantComparisonView => ({
    permissionSlug: 'feedback:read',
    scopeType: PluginGrantScope.Server,
    status: PluginGrantStatus.Granted,
    decidedRiskLevel: RiskLevel.Low,
    ...overrides,
  });

  const compare = (overrides: Partial<EscalationComparatorInput> = {}) =>
    compareForEscalations({
      active: view(),
      next: view(),
      grants: [],
      currentRiskBySlug: new Map(),
      ...overrides,
    });

  it('reports no escalations and no gating for identical manifests', () => {
    const shared = view({
      outboundDomains: ['api.example.com'],
      writesCore: ['GameNight'],
      checks: [check('feedback:read')],
    });

    const result = compare({ active: shared, next: shared });

    expect(result.escalations).toEqual([]);
    expect(result.serverGating).toBe(false);
    expect(result.blockedByDenial).toEqual([]);
    expect(result.householdReconsentSlugs).toEqual([]);
    expect(result.serverRiskEscalatedSlugs).toEqual([]);
    expect(result.userReconsentSlugs).toEqual([]);
  });

  describe('permission escalations', () => {
    it('flags a new server-consentable check and server-gates on it', () => {
      const result = compare({ next: view({ checks: [check('feedback:read', 'server', false)] }) });

      expect(result.escalations).toEqual([
        { kind: 'new-permission', slug: 'feedback:read', consentScope: 'server', required: false },
      ]);
      expect(result.serverGating).toBe(true);
    });

    it('flags a new household check WITHOUT server-gating — its consent belongs to the units', () => {
      const result = compare({ next: view({ checks: [check('calendar:read', 'household', true)] }) });

      expect(result.serverGating).toBe(false);
      expect(result.escalations).toEqual([
        { kind: 'new-permission', slug: 'calendar:read', consentScope: 'household', required: true },
      ]);
      expect(result.householdReconsentSlugs).toEqual(['calendar:read']);
    });

    it('excludes a new OPTIONAL household check from the suspension set', () => {
      const result = compare({ next: view({ checks: [check('calendar:read', 'household', false)] }) });

      expect(result.householdReconsentSlugs).toEqual([]);
    });

    it('flags a required promotion at household scope into the suspension set', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household', false)] }),
        next: view({ checks: [check('calendar:read', 'household', true)] }),
      });

      expect(result.escalations).toEqual([
        { kind: 'permission-promoted-to-required', slug: 'calendar:read', consentScope: 'household' },
      ]);
      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual(['calendar:read']);
    });

    it('routes a new REQUIRED user check to the user re-consent set without server-gating (#225 parity)', () => {
      const result = compare({ next: view({ checks: [check('read:user_calendar', 'user', true)] }) });

      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual([]);
      expect(result.userReconsentSlugs).toEqual(['read:user_calendar']);
    });

    it('excludes a new OPTIONAL user check from the re-consent set', () => {
      const result = compare({ next: view({ checks: [check('read:user_calendar', 'user', false)] }) });

      expect(result.userReconsentSlugs).toEqual([]);
    });

    it('flags a required promotion at user scope into the re-consent set', () => {
      const result = compare({
        active: view({ checks: [check('read:user_calendar', 'user', false)] }),
        next: view({ checks: [check('read:user_calendar', 'user', true)] }),
      });

      expect(result.escalations).toEqual([
        { kind: 'permission-promoted-to-required', slug: 'read:user_calendar', consentScope: 'user' },
      ]);
      expect(result.userReconsentSlugs).toEqual(['read:user_calendar']);
    });

    it('treats a required demotion and a removed check as narrowings', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read', 'server', true), check('calendar:read', 'household', true)] }),
        next: view({ checks: [check('feedback:read', 'server', false)] }),
      });

      expect(result.escalations).toEqual([]);
      expect(result.serverGating).toBe(false);
    });
  });

  describe('risk escalation', () => {
    it('flags a grant whose current catalog risk exceeds the decided risk, and server-gates', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read')] }),
        next: view({ checks: [check('feedback:read')] }),
        grants: [grant({ decidedRiskLevel: RiskLevel.Low })],
        currentRiskBySlug: new Map([['feedback:read', RiskLevel.High]]),
      });

      expect(result.escalations).toEqual([
        {
          kind: 'risk-escalated',
          slug: 'feedback:read',
          scopeType: PluginGrantScope.Server,
          decidedRiskLevel: RiskLevel.Low,
          currentRiskLevel: RiskLevel.High,
        },
      ]);
      expect(result.serverGating).toBe(true);
    });

    it('ignores equal or LOWERED current risk', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read')] }),
        next: view({ checks: [check('feedback:read')] }),
        grants: [grant({ decidedRiskLevel: RiskLevel.High })],
        currentRiskBySlug: new Map([['feedback:read', RiskLevel.Medium]]),
      });

      expect(result.escalations).toEqual([]);
    });

    it('routes a HOUSEHOLD-scope escalation to the unit, not the server admin', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household')] }),
        next: view({ checks: [check('calendar:read', 'household')] }),
        grants: [
          grant({
            permissionSlug: 'calendar:read',
            scopeType: PluginGrantScope.Household,
            decidedRiskLevel: RiskLevel.Low,
          }),
        ],
        currentRiskBySlug: new Map([['calendar:read', RiskLevel.High]]),
      });

      // Gating the server admin here would ask the wrong principal to
      // re-consent AND leave the household never asked.
      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual(['calendar:read']);
      expect(result.serverRiskEscalatedSlugs).toEqual([]);
    });

    it('routes a SERVER-scope escalation to the approval path so it can be re-stamped', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read')] }),
        next: view({ checks: [check('feedback:read')] }),
        grants: [grant({ decidedRiskLevel: RiskLevel.Low })],
        currentRiskBySlug: new Map([['feedback:read', RiskLevel.Critical]]),
      });

      expect(result.serverGating).toBe(true);
      expect(result.serverRiskEscalatedSlugs).toEqual(['feedback:read']);
      expect(result.householdReconsentSlugs).toEqual([]);
    });

    it('routes a USER-scope escalation to the user units, not the server admin (#225)', () => {
      const result = compare({
        active: view({ checks: [check('read:public_content', 'user')] }),
        next: view({ checks: [check('read:public_content', 'user')] }),
        grants: [
          grant({
            permissionSlug: 'read:public_content',
            scopeType: PluginGrantScope.User,
            decidedRiskLevel: RiskLevel.Low,
          }),
        ],
        currentRiskBySlug: new Map([['read:public_content', RiskLevel.High]]),
      });

      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual([]);
      expect(result.userReconsentSlugs).toEqual(['read:public_content']);
    });

    it('ignores a DENIED row whose risk rose — a refusal confers nothing to re-consent or re-stamp', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read')] }),
        next: view({ checks: [check('feedback:read')] }),
        grants: [grant({ status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low })],
        currentRiskBySlug: new Map([['feedback:read', RiskLevel.Critical]]),
      });

      expect(result.escalations).toEqual([]);
      expect(result.serverGating).toBe(false);
      expect(result.serverRiskEscalatedSlugs).toEqual([]);
    });

    it('ignores grants on checks the next manifest no longer requests', () => {
      const result = compare({
        grants: [grant({ decidedRiskLevel: RiskLevel.Low })],
        currentRiskBySlug: new Map([['feedback:read', RiskLevel.Critical]]),
      });

      expect(result.escalations).toEqual([]);
    });
  });

  describe('consent-scope changes', () => {
    it('gates the server when a permission moves household → server', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household', true)] }),
        next: view({ checks: [check('calendar:read', 'server', true)] }),
      });

      expect(result.escalations).toEqual([
        { kind: 'consent-scope-changed', slug: 'calendar:read', from: 'household', to: 'server', required: true },
      ]);
      // Without this the update activates immediately, seeds no server grant,
      // and leaves no approval path that ever would.
      expect(result.serverGating).toBe(true);
      expect(result.householdReconsentSlugs).toEqual([]);
    });

    it('sends a required permission moving server → household to the units', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'server', true)] }),
        next: view({ checks: [check('calendar:read', 'household', true)] }),
      });

      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual(['calendar:read']);
    });

    it('does NOT also route a stale OLD-scope grant as a risk escalation — the scope change subsumes it', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household', true)] }),
        next: view({ checks: [check('calendar:read', 'user', true)] }),
        grants: [
          grant({
            permissionSlug: 'calendar:read',
            scopeType: PluginGrantScope.Household,
            decidedRiskLevel: RiskLevel.Low,
          }),
        ],
        currentRiskBySlug: new Map([['calendar:read', RiskLevel.High]]),
      });

      // Suspending the household would strand it: the permission is no
      // longer a household check, so decide() refuses a household decision
      // on it and the unit could never clear its own suspension.
      expect(result.householdReconsentSlugs).toEqual([]);
      expect(result.userReconsentSlugs).toEqual(['calendar:read']);
      expect(result.escalations).not.toContainEqual(expect.objectContaining({ kind: 'risk-escalated' }));
    });

    it('does not gate the server admin on a stale SERVER grant for a permission moving away from server scope', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'server', true)] }),
        next: view({ checks: [check('calendar:read', 'user', true)] }),
        grants: [
          grant({
            permissionSlug: 'calendar:read',
            scopeType: PluginGrantScope.Server,
            decidedRiskLevel: RiskLevel.Low,
          }),
        ],
        currentRiskBySlug: new Map([['calendar:read', RiskLevel.High]]),
      });

      // Activation deletes that grant as scope-moved; re-approving it would
      // ask the admin to re-consent to something they are about to stop owning.
      expect(result.serverGating).toBe(false);
      expect(result.serverRiskEscalatedSlugs).toEqual([]);
      expect(result.userReconsentSlugs).toEqual(['calendar:read']);
    });

    it('still routes a risk escalation normally when the consent scope did NOT change', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household', true)] }),
        next: view({ checks: [check('calendar:read', 'household', true)] }),
        grants: [
          grant({
            permissionSlug: 'calendar:read',
            scopeType: PluginGrantScope.Household,
            decidedRiskLevel: RiskLevel.Low,
          }),
        ],
        currentRiskBySlug: new Map([['calendar:read', RiskLevel.High]]),
      });

      expect(result.householdReconsentSlugs).toEqual(['calendar:read']);
      expect(result.escalations).toContainEqual(expect.objectContaining({ kind: 'risk-escalated' }));
    });

    it('sends a required permission moving to USER consent to the user units (#225 parity)', () => {
      const result = compare({
        active: view({ checks: [check('read:user_calendar', 'household', true)] }),
        next: view({ checks: [check('read:user_calendar', 'user', true)] }),
      });

      expect(result.serverGating).toBe(false);
      expect(result.householdReconsentSlugs).toEqual([]);
      expect(result.userReconsentSlugs).toEqual(['read:user_calendar']);
    });

    it('reports the move ONCE when the scope change coincides with a required promotion', () => {
      const result = compare({
        active: view({ checks: [check('calendar:read', 'household', false)] }),
        next: view({ checks: [check('calendar:read', 'server', true)] }),
      });

      expect(result.escalations).toEqual([
        { kind: 'consent-scope-changed', slug: 'calendar:read', from: 'household', to: 'server', required: true },
      ]);
    });
  });

  describe("outbound domains ('configured' transitions)", () => {
    it('flags each added domain', () => {
      const result = compare({
        active: view({ outboundDomains: ['a.example.com'] }),
        next: view({ outboundDomains: ['a.example.com', 'b.example.com'] }),
      });

      expect(result.escalations).toEqual([{ kind: 'outbound-domain-added', domain: 'b.example.com' }]);
      expect(result.serverGating).toBe(true);
    });

    it("treats list → 'configured' as a broadening escalation", () => {
      const result = compare({
        active: view({ outboundDomains: ['a.example.com'] }),
        next: view({ outboundDomains: 'configured' }),
      });

      expect(result.escalations).toEqual([{ kind: 'outbound-domains-configured' }]);
      expect(result.serverGating).toBe(true);
    });

    it("treats 'configured' → list as a narrowing and 'configured' → 'configured' as no change", () => {
      expect(
        compare({ active: view({ outboundDomains: 'configured' }), next: view({ outboundDomains: ['a.example.com'] }) })
          .escalations,
      ).toEqual([]);
      expect(
        compare({ active: view({ outboundDomains: 'configured' }), next: view({ outboundDomains: 'configured' }) })
          .escalations,
      ).toEqual([]);
    });

    it('does not flag removed domains', () => {
      const result = compare({
        active: view({ outboundDomains: ['a.example.com', 'b.example.com'] }),
        next: view({ outboundDomains: ['a.example.com'] }),
      });

      expect(result.escalations).toEqual([]);
    });
  });

  describe('writesCore', () => {
    it('flags each added core model and server-gates', () => {
      const result = compare({
        active: view({ writesCore: ['GameNight'] }),
        next: view({ writesCore: ['GameNight', 'Event'] }),
      });

      expect(result.escalations).toEqual([{ kind: 'writes-core-added', model: 'Event' }]);
      expect(result.serverGating).toBe(true);
    });

    it('ignores removals', () => {
      const result = compare({ active: view({ writesCore: ['GameNight'] }), next: view({ writesCore: [] }) });

      expect(result.escalations).toEqual([]);
    });
  });

  describe('denial block', () => {
    it('blocks on a server-scope Denied row for a permission the next manifest requires', () => {
      const result = compare({
        active: view({ checks: [check('feedback:read', 'server', false)] }),
        next: view({ checks: [check('feedback:read', 'server', true)] }),
        grants: [grant({ status: PluginGrantStatus.Denied })],
      });

      expect(result.blockedByDenial).toEqual(['feedback:read']);
    });

    it('blocks even when the denial predates the update and nothing else escalated', () => {
      const shared = view({ checks: [check('feedback:read', 'server', true)] });
      const result = compare({ active: shared, next: shared, grants: [grant({ status: PluginGrantStatus.Denied })] });

      expect(result.escalations).toEqual([]);
      expect(result.blockedByDenial).toEqual(['feedback:read']);
    });

    it('does not block on optional-check denials or household-scope denials', () => {
      const result = compare({
        next: view({ checks: [check('feedback:read', 'server', false), check('calendar:read', 'household', true)] }),
        grants: [
          grant({ status: PluginGrantStatus.Denied }),
          grant({
            permissionSlug: 'calendar:read',
            scopeType: PluginGrantScope.Household,
            status: PluginGrantStatus.Denied,
          }),
        ],
      });

      expect(result.blockedByDenial).toEqual([]);
    });
  });
});
