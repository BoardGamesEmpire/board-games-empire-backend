import type { PluginUnit } from '@bge/actor-context';
import { RiskLevel } from '@bge/database';
import type { NormalizedPermissionRequest, PluginConsentScopeValue } from '@boardgamesempire/plugin-manifest';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import type { ClassifiedConsentCheck, ConsentCheckClassification } from './consent-classification.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import { PluginConsentStandingService } from './plugin-consent-standing.service';

describe('PluginConsentStandingService (#1149)', () => {
  const options = buildPluginModuleOptions();

  const SERVER_UNIT: PluginUnit = { scopeType: 'Server' };
  const HOUSEHOLD_UNIT: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };

  const check = (
    slug: string,
    consentScope: PluginConsentScopeValue,
    overrides: Partial<Omit<NormalizedPermissionRequest, 'slug' | 'consentScope'>> = {},
  ): NormalizedPermissionRequest => ({
    slug,
    canonicalSlug: slug,
    consentScope,
    origin: 'core',
    required: false,
    reason: { en: `Needs ${slug}.` },
    ...overrides,
  });

  const classified = (overrides: Partial<ClassifiedConsentCheck> = {}): ClassifiedConsentCheck => ({
    decision: 'pending',
    decidedRiskLevel: null,
    staleRisk: false,
    ...overrides,
  });

  const classification = (
    decisions: Record<string, ClassifiedConsentCheck>,
    risks: Record<string, RiskLevel> = {},
  ): ConsentCheckClassification => ({
    decisions: new Map(Object.entries(decisions)),
    currentRiskBySlug: new Map(Object.entries(risks)),
  });

  let classify: jest.Mock<Promise<ConsentCheckClassification>, Parameters<PluginConsentCheckClassifier['classify']>>;
  let service: PluginConsentStandingService;

  beforeEach(() => {
    classify = jest.fn();
    service = new PluginConsentStandingService({ classify } as unknown as PluginConsentCheckClassifier, options);
  });

  afterEach(() => jest.clearAllMocks());

  it('lists a required check with no row as never_asked under outstanding', async () => {
    const notify = check('create:notification', 'household', { required: true, feature: 'weekly-digest' });
    classify.mockResolvedValue(
      classification({ 'create:notification': classified() }, { 'create:notification': RiskLevel.Medium }),
    );

    const standing = await service.resolve('plg_1', HOUSEHOLD_UNIT, [notify]);

    expect(standing).toEqual({
      outstanding: [
        {
          slug: 'create:notification',
          kind: 'never_asked',
          required: true,
          feature: 'weekly-digest',
          riskLevel: RiskLevel.Medium,
          reason: 'Needs create:notification.',
        },
      ],
      optionalOff: [],
    });
  });

  it('lists a Denied optional check as refused under optionalOff and never under outstanding', async () => {
    // A refused optional permission only switches its feature off; it must
    // never count toward the unit's outstanding required permissions, or a
    // household that said no to an optional permission reads as review
    // pending forever (#1149).
    const calendar = check('update:calendar', 'household');
    classify.mockResolvedValue(
      classification(
        { 'update:calendar': classified({ decision: 'denied', decidedRiskLevel: RiskLevel.Low }) },
        { 'update:calendar': RiskLevel.Low },
      ),
    );

    const standing = await service.resolve('plg_1', HOUSEHOLD_UNIT, [calendar]);

    expect(standing.outstanding).toEqual([]);
    expect(standing.optionalOff).toEqual([
      {
        slug: 'update:calendar',
        kind: 'refused',
        required: false,
        feature: null,
        riskLevel: RiskLevel.Low,
        reason: 'Needs update:calendar.',
      },
    ]);
  });

  it('lists a Granted check whose risk rose as risk_raised', async () => {
    // A catalog risk raise has no writer: the stale Granted row reads as
    // review pending until the unit consents again (#1149).
    const notify = check('create:notification', 'household', { required: true });
    classify.mockResolvedValue(
      classification(
        {
          'create:notification': classified({ decidedRiskLevel: RiskLevel.Low, staleRisk: true }),
        },
        { 'create:notification': RiskLevel.High },
      ),
    );

    const standing = await service.resolve('plg_1', HOUSEHOLD_UNIT, [notify]);

    expect(standing.outstanding).toEqual([
      expect.objectContaining({ slug: 'create:notification', kind: 'risk_raised', riskLevel: RiskLevel.High }),
    ]);
    expect(standing.optionalOff).toEqual([]);
  });

  it('reports a server-scope check nobody granted as outstanding_elsewhere from a household', async () => {
    // The household's resolution consumes server-consented checks but cannot
    // decide them; naming the kind tells the client the cure is a server
    // admin's, not the household's (#1149, #1147).
    const feedback = check('feedback:read', 'server', { required: true });
    classify.mockResolvedValue(classification({ 'feedback:read': classified() }));

    const standing = await service.resolve('plg_1', HOUSEHOLD_UNIT, [feedback]);

    expect(standing.outstanding).toEqual([
      {
        slug: 'feedback:read',
        kind: 'outstanding_elsewhere',
        required: true,
        feature: null,
        riskLevel: null,
        reason: 'Needs feedback:read.',
      },
    ]);
  });

  it('reports a server-scope check a server admin refused as outstanding_elsewhere from a household, not refused', async () => {
    // Ownership is asked before refusal: the household cannot reverse a
    // server admin's refusal, so it must not be offered a decision (#1147).
    const feedback = check('feedback:read', 'server', { required: true });
    classify.mockResolvedValue(
      classification({ 'feedback:read': classified({ decision: 'denied', decidedRiskLevel: RiskLevel.Low }) }),
    );

    const { standing, refusedSlugs } = await service.resolveDetailed('plg_1', HOUSEHOLD_UNIT, [feedback]);

    expect(standing.outstanding).toEqual([
      expect.objectContaining({ slug: 'feedback:read', kind: 'outstanding_elsewhere' }),
    ]);
    // The detail still names the refusal, so feature state can say the
    // feature is denied rather than waiting.
    expect([...refusedSlugs]).toEqual(['feedback:read']);
  });

  it('names no refused slug for checks that are merely pending', async () => {
    const notify = check('create:notification', 'household', { required: true });
    classify.mockResolvedValue(classification({ 'create:notification': classified() }));

    const { refusedSlugs } = await service.resolveDetailed('plg_1', HOUSEHOLD_UNIT, [notify]);

    expect(refusedSlugs.size).toBe(0);
  });

  it('reports a declared permission with no catalog row at Low, as the consent surface does; a core one at null', async () => {
    const declared = check('plugin|demo|read:digest', 'server', { origin: 'plugin', required: true });
    const core = check('feedback:read', 'server', { required: true });
    classify.mockResolvedValue(
      classification({ 'plugin|demo|read:digest': classified(), 'feedback:read': classified() }),
    );

    const standing = await service.resolve('plg_1', SERVER_UNIT, [declared, core]);

    expect(standing.outstanding).toEqual([
      expect.objectContaining({ slug: 'plugin|demo|read:digest', riskLevel: RiskLevel.Low }),
      expect.objectContaining({ slug: 'feedback:read', riskLevel: null }),
    ]);
  });

  it('reports a server-scope check refused at the Server unit as refused, never outstanding_elsewhere', async () => {
    // The Server unit owns server-consented checks, so its own refusal is
    // its own to revisit (#1149).
    const feedback = check('feedback:read', 'server', { required: true });
    classify.mockResolvedValue(
      classification({ 'feedback:read': classified({ decision: 'denied', decidedRiskLevel: RiskLevel.Low }) }),
    );

    const standing = await service.resolve('plg_1', SERVER_UNIT, [feedback]);

    expect(standing.outstanding).toEqual([expect.objectContaining({ slug: 'feedback:read', kind: 'refused' })]);
  });

  it('omits every conferring check and every check the unit does not consume', async () => {
    const granted = check('create:notification', 'household', { required: true });
    const userOwned = check('read:public_content', 'user', { required: true });
    const later = check('update:calendar', 'household', { required: true });
    const earlier = check('feedback:read', 'server', { required: true });
    classify.mockResolvedValue(
      classification({
        'create:notification': classified({ decision: 'granted', decidedRiskLevel: RiskLevel.Low }),
        'update:calendar': classified(),
        'feedback:read': classified(),
      }),
    );

    const standing = await service.resolve('plg_1', HOUSEHOLD_UNIT, [granted, userOwned, later, earlier]);

    // One classifier call, over only the checks the household's resolution
    // consumes: a user-consented check is decided per user, never here.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('plg_1', HOUSEHOLD_UNIT, [granted, later, earlier]);
    // Manifest order, not slug order.
    expect(standing.outstanding.map((entry) => entry.slug)).toEqual(['update:calendar', 'feedback:read']);
    expect(standing.optionalOff).toEqual([]);
  });

  it('resolves reason text in the requested locale with the manifest fallback chain', async () => {
    const notify = check('create:notification', 'household', {
      required: true,
      reason: { en: 'Sends the weekly digest.', de: 'Sendet die Wochenübersicht.' },
    });
    classify.mockResolvedValue(classification({ 'create:notification': classified() }));

    const regional = await service.resolve('plg_1', HOUSEHOLD_UNIT, [notify], 'de-AT');
    const unsupported = await service.resolve('plg_1', HOUSEHOLD_UNIT, [notify], 'fr');
    const unspecified = await service.resolve('plg_1', HOUSEHOLD_UNIT, [notify]);

    expect(regional.outstanding[0]?.reason).toBe('Sendet die Wochenübersicht.');
    expect(unsupported.outstanding[0]?.reason).toBe('Sends the weekly digest.');
    expect(unspecified.outstanding[0]?.reason).toBe('Sends the weekly digest.');
  });
});
