import { PluginGrantStatus, RiskLevel } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { planServerAcceptance, planServerApproval, staleShownRisks } from './server-acceptance';

const check = (
  canonicalSlug: string,
  overrides: Partial<NormalizedPermissionRequest> = {},
): NormalizedPermissionRequest => ({
  slug: canonicalSlug,
  required: false,
  reason: { en: `Needed for ${canonicalSlug}.` },
  consentScope: 'server',
  origin: 'core',
  canonicalSlug,
  ...overrides,
});

// Manifest order deliberately differs from code-unit order, so the sort shows.
const WRITE_GAME = check('write:game:public', { required: true, feature: 'import' });
const READ_PLAY = check('read:play:public', { reason: { en: 'Reads plays.', fr: 'Lit les parties.' } });
const MANAGE_DIGEST = check('plug:manage:digest', { origin: 'plugin', slug: 'manage:digest' });

const RISKS: Record<string, RiskLevel> = {
  'write:game:public': RiskLevel.High,
  'read:play:public': RiskLevel.Medium,
  'plug:manage:digest': RiskLevel.Low,
};

const riskOf = (permission: NormalizedPermissionRequest): RiskLevel => RISKS[permission.canonicalSlug];

type AcceptanceInput = Parameters<typeof planServerAcceptance>[0];

const accept = (overrides: Partial<AcceptanceInput> = {}) =>
  planServerAcceptance({
    accepted: [WRITE_GAME, READ_PLAY, MANAGE_DIGEST],
    shown: [WRITE_GAME, READ_PLAY, MANAGE_DIGEST],
    riskOf,
    source: 'active',
    locale: 'en',
    defaultLocale: 'en',
    ...overrides,
  });

describe('planServerAcceptance (#1336)', () => {
  it('grants every accepted requested permission at riskOf, in code-unit order of slug', () => {
    expect(accept().decisions).toEqual([
      { permissionSlug: 'plug:manage:digest', status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
      { permissionSlug: 'read:play:public', status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Medium },
      { permissionSlug: 'write:game:public', status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.High },
    ]);
  });

  it('presents every shown requested permission in manifest order, as a toggle act records it', () => {
    expect(accept().presentation).toEqual({
      locale: 'en',
      source: 'active',
      checks: [
        {
          slug: 'write:game:public',
          required: true,
          feature: 'import',
          riskLevel: RiskLevel.High,
          reason: 'Needed for write:game:public.',
          usedFallback: false,
          outcome: 'granted',
        },
        {
          slug: 'read:play:public',
          required: false,
          feature: null,
          riskLevel: RiskLevel.Medium,
          reason: 'Reads plays.',
          usedFallback: false,
          outcome: 'granted',
        },
        {
          slug: 'plug:manage:digest',
          required: false,
          feature: null,
          riskLevel: RiskLevel.Low,
          reason: 'Needed for plug:manage:digest.',
          usedFallback: false,
          outcome: 'granted',
        },
      ],
    });
  });

  it('reads a shown requested permission the acceptance does not grant as unanswered', () => {
    const plan = accept({ accepted: [WRITE_GAME] });

    expect(plan.decisions.map((decision) => decision.permissionSlug)).toEqual(['write:game:public']);
    expect(plan.presentation.checks.map((shown) => [shown.slug, shown.outcome])).toEqual([
      ['write:game:public', 'granted'],
      ['read:play:public', 'unanswered'],
      ['plug:manage:digest', 'unanswered'],
    ]);
  });

  it('resolves each reason in the locale, and marks the ones that fell back to the default', () => {
    const plan = accept({ locale: 'fr' });

    expect(plan.presentation.locale).toBe('fr');
    expect(plan.presentation.checks.map((shown) => [shown.reason, shown.usedFallback])).toEqual([
      ['Needed for write:game:public.', true],
      ['Lit les parties.', false],
      ['Needed for plug:manage:digest.', true],
    ]);
  });

  it('carries the source of the manifest shown', () => {
    expect(accept({ source: 'staged' }).presentation.source).toBe('staged');
  });

  it('accepts nothing and still records what was shown when nothing is accepted', () => {
    const plan = accept({ accepted: [] });

    expect(plan.decisions).toEqual([]);
    expect(plan.presentation.checks).toHaveLength(3);
    expect(plan.presentation.checks.every((shown) => shown.outcome === 'unanswered')).toBe(true);
  });

  it('records an empty presentation for a manifest that requests nothing of the server', () => {
    expect(accept({ accepted: [], shown: [] })).toEqual({
      decisions: [],
      presentation: { locale: 'en', source: 'active', checks: [] },
    });
  });
});

describe('planServerApproval (#1336)', () => {
  type ApprovalInput = Parameters<typeof planServerApproval>[0];
  type Decision = ApprovalInput['decisions'][number];

  const decision = (permissionSlug: string, status: PluginGrantStatus, decidedRiskLevel: RiskLevel): Decision => ({
    permissionSlug,
    status,
    decidedRiskLevel,
  });

  const HOUSEHOLD_READ = check('read:household', { consentScope: 'household', required: true });

  const approve = (overrides: Partial<ApprovalInput> = {}) =>
    planServerApproval({
      requested: [WRITE_GAME, READ_PLAY, MANAGE_DIGEST, HOUSEHOLD_READ],
      decisions: [],
      riskOf,
      ...overrides,
    });

  const slugs = (checks: readonly NormalizedPermissionRequest[]) => checks.map((one) => one.canonicalSlug);

  it('accepts every server-scope requested permission when the Server unit has decided nothing, and confers them all', () => {
    const plan = approve();

    // Manifest order; the household-scope one is not the server's to accept.
    expect(slugs(plan.accepted)).toEqual(['write:game:public', 'read:play:public', 'plug:manage:digest']);
    expect(slugs(plan.newlyConferred)).toEqual(['write:game:public', 'read:play:public', 'plug:manage:digest']);
  });

  it('accepts a required permission that was denied, and counts it as newly conferred', () => {
    const plan = approve({
      decisions: [
        decision('write:game:public', PluginGrantStatus.Denied, RiskLevel.High),
        decision('read:play:public', PluginGrantStatus.Granted, RiskLevel.Medium),
        decision('plug:manage:digest', PluginGrantStatus.Granted, RiskLevel.Low),
      ],
    });

    expect(slugs(plan.accepted)).toEqual(['write:game:public']);
    expect(slugs(plan.newlyConferred)).toEqual(['write:game:public']);
  });

  it('re-accepts a required permission granted at a covering risk, and confers nothing new through it', () => {
    const plan = approve({
      decisions: [
        // Granted above today's risk still covers it.
        decision('write:game:public', PluginGrantStatus.Granted, RiskLevel.Critical),
        decision('read:play:public', PluginGrantStatus.Granted, RiskLevel.Medium),
        decision('plug:manage:digest', PluginGrantStatus.Granted, RiskLevel.Low),
      ],
    });

    expect(slugs(plan.accepted)).toEqual(['write:game:public']);
    expect(plan.newlyConferred).toEqual([]);
  });

  it('confers a required permission granted at a risk that no longer covers today', () => {
    const plan = approve({
      decisions: [
        decision('write:game:public', PluginGrantStatus.Granted, RiskLevel.Medium),
        decision('read:play:public', PluginGrantStatus.Granted, RiskLevel.Medium),
        decision('plug:manage:digest', PluginGrantStatus.Granted, RiskLevel.Low),
      ],
    });

    expect(slugs(plan.newlyConferred)).toEqual(['write:game:public']);
  });

  it('leaves an existing optional decision alone when it is a denial', () => {
    const plan = approve({
      decisions: [
        decision('write:game:public', PluginGrantStatus.Granted, RiskLevel.High),
        decision('read:play:public', PluginGrantStatus.Denied, RiskLevel.Medium),
      ],
    });

    // MANAGE_DIGEST is optional with no decision yet, so it is accepted.
    expect(slugs(plan.accepted)).toEqual(['write:game:public', 'plug:manage:digest']);
    expect(slugs(plan.newlyConferred)).toEqual(['plug:manage:digest']);
  });

  it('leaves an existing optional decision alone when it is granted at a risk that has since risen, so it is not in what the approval confers', () => {
    const plan = approve({
      decisions: [
        decision('write:game:public', PluginGrantStatus.Granted, RiskLevel.High),
        decision('read:play:public', PluginGrantStatus.Granted, RiskLevel.Low),
        decision('plug:manage:digest', PluginGrantStatus.Granted, RiskLevel.Low),
      ],
    });

    // Outstanding for a review act, not for this approval.
    expect(slugs(plan.accepted)).toEqual(['write:game:public']);
    expect(plan.newlyConferred).toEqual([]);
  });

  it('accepts nothing for a manifest that requests nothing of the server', () => {
    expect(approve({ requested: [HOUSEHOLD_READ] })).toEqual({ accepted: [], newlyConferred: [] });
  });
});

describe('staleShownRisks (#1336)', () => {
  const SHOWN = [WRITE_GAME, READ_PLAY, MANAGE_DIGEST];
  const current = SHOWN.map((permission) => ({
    permissionSlug: permission.canonicalSlug,
    riskLevel: riskOf(permission),
  }));

  it("finds nothing stale when every risk named is today's", () => {
    expect(staleShownRisks(SHOWN, riskOf, current)).toEqual([]);
  });

  it('names a risk that rose after the read, with what was shown and what stands', () => {
    // Install and approval stamp today's risk: without this, High would be
    // recorded as the risk shown when Medium was.
    const shown = current.map((risk) =>
      risk.permissionSlug === 'write:game:public' ? { ...risk, riskLevel: RiskLevel.Medium } : risk,
    );

    expect(staleShownRisks(SHOWN, riskOf, shown)).toEqual([
      { permissionSlug: 'write:game:public', shownRiskLevel: RiskLevel.Medium, currentRiskLevel: RiskLevel.High },
    ]);
  });

  it('names a risk that fell too: what was shown is not what stands', () => {
    const shown = current.map((risk) =>
      risk.permissionSlug === 'read:play:public' ? { ...risk, riskLevel: RiskLevel.Critical } : risk,
    );

    expect(staleShownRisks(SHOWN, riskOf, shown)).toEqual([
      { permissionSlug: 'read:play:public', shownRiskLevel: RiskLevel.Critical, currentRiskLevel: RiskLevel.Medium },
    ]);
  });

  it('names a requested permission the request gave no risk for, as shown nothing', () => {
    const shown = current.filter((risk) => risk.permissionSlug !== 'plug:manage:digest');

    expect(staleShownRisks(SHOWN, riskOf, shown)).toEqual([
      { permissionSlug: 'plug:manage:digest', shownRiskLevel: null, currentRiskLevel: RiskLevel.Low },
    ]);
  });

  it('ignores a risk named for a permission the manifest does not request at server scope', () => {
    const shown = [...current, { permissionSlug: 'read:household', riskLevel: RiskLevel.Critical }];

    expect(staleShownRisks(SHOWN, riskOf, shown)).toEqual([]);
  });
});
