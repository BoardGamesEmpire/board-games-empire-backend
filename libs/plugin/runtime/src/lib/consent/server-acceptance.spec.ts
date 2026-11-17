import { PluginGrantStatus, RiskLevel } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { planServerAcceptance } from './server-acceptance';

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
