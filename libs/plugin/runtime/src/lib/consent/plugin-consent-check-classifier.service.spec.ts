import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  grantScopeCoordinatesForUnit,
  PERMISSION_CATALOG,
  PluginGrantScope,
  PluginGrantStatus,
  RiskLevel,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { unitConsumesConsentScope, unitOwnsConsentScope } from './consent-classification.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';

describe('consent scope predicates', () => {
  const SERVER: PluginUnit = { scopeType: 'Server' };
  const HOUSEHOLD: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };
  const USER: PluginUnit = { scopeType: 'User', userId: 'u-1' };

  it('unitOwnsConsentScope is the exact axis match', () => {
    expect(unitOwnsConsentScope('server', SERVER)).toBe(true);
    expect(unitOwnsConsentScope('household', SERVER)).toBe(false);
    expect(unitOwnsConsentScope('household', HOUSEHOLD)).toBe(true);
    expect(unitOwnsConsentScope('user', HOUSEHOLD)).toBe(false);
    expect(unitOwnsConsentScope('user', USER)).toBe(true);
    expect(unitOwnsConsentScope('server', USER)).toBe(false);
  });

  it("unitConsumesConsentScope adds server checks to every unit, mirroring the read path's grant scoping", () => {
    expect(unitConsumesConsentScope('server', HOUSEHOLD)).toBe(true);
    expect(unitConsumesConsentScope('server', USER)).toBe(true);
    expect(unitConsumesConsentScope('household', HOUSEHOLD)).toBe(true);
    expect(unitConsumesConsentScope('household', USER)).toBe(false);
    expect(unitConsumesConsentScope('user', SERVER)).toBe(false);
  });
});

describe('PluginConsentCheckClassifier', () => {
  const HOUSEHOLD_UNIT: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };

  const check = (
    canonicalSlug: string,
    overrides: Partial<NormalizedPermissionRequest> = {},
  ): NormalizedPermissionRequest => ({
    slug: canonicalSlug,
    required: false,
    reason: { en: 'Because the spec says so.' },
    consentScope: 'household',
    origin: 'core',
    canonicalSlug,
    ...overrides,
  });

  const OWN_CANONICAL = 'plugin|demo-sink|read:digest';

  let db: MockDatabaseService;
  let classifier: PluginConsentCheckClassifier;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.pluginGrant.findMany.mockResolvedValue([] as never);
    db.permission.findMany.mockResolvedValue([] as never);
    db.pluginPermission.findMany.mockResolvedValue([] as never);

    classifier = new PluginConsentCheckClassifier(db as unknown as DatabaseService);
  });

  afterEach(() => jest.clearAllMocks());

  it('answers nothing for no checks — and runs no queries', async () => {
    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, []);

    expect(result.decisions.size).toBe(0);
    expect(result.currentRiskBySlug.size).toBe(0);
    expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
    expect(db.permission.findMany).not.toHaveBeenCalled();
  });

  it('classifies only unit-addressable checks, but reports catalog risk for every check', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'feedback:read', riskLevel: RiskLevel.Low, subject: 'Feedback' },
      { slug: 'create:notification', riskLevel: RiskLevel.Medium, subject: 'Notification' },
      { slug: 'read:public_content', riskLevel: RiskLevel.High, subject: 'Content' },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [
      check('feedback:read', { consentScope: 'server' }),
      check('create:notification'),
      check('read:public_content', { consentScope: 'user' }),
    ]);

    expect([...result.decisions.keys()].sort()).toEqual(['create:notification', 'feedback:read']);
    expect(result.currentRiskBySlug.get('read:public_content')).toBe(RiskLevel.High);
    expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: grantScopeCoordinatesForUnit(HOUSEHOLD_UNIT),
          permissionSlug: { in: ['feedback:read', 'create:notification'] },
        }),
      }),
    );
  });

  it('skips the grant query entirely when nothing is addressable, still loading the catalog', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'read:public_content', riskLevel: RiskLevel.Low, subject: 'Content' },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [
      check('read:public_content', { consentScope: 'user' }),
    ]);

    expect(result.decisions.size).toBe(0);
    expect(result.currentRiskBySlug.get('read:public_content')).toBe(RiskLevel.Low);
    expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
    expect(db.permission.findMany).toHaveBeenCalled();
  });

  it('a missing row is pending with no decided risk', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'create:notification', riskLevel: RiskLevel.Low, subject: 'Notification' },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'pending',
      decidedRiskLevel: null,
      staleRisk: false,
    });
  });

  it('a Denied row is durable refusal, carrying its decided risk', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'create:notification', riskLevel: RiskLevel.Low, subject: 'Notification' },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Denied,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'denied',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: false,
    });
  });

  it('a covering Granted row confers', async () => {
    db.permission.findMany.mockResolvedValue([
      {
        slug: 'create:notification',
        riskLevel: RiskLevel.Low,
        subject: 'Notification',
        conditions: { householdId: '{{ unit.householdId }}' },
      },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'granted',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: false,
    });
  });

  it('a Granted row at stale risk is pending with staleRisk marked — consent must be re-made at the current classification', async () => {
    db.permission.findMany.mockResolvedValue([
      {
        slug: 'create:notification',
        riskLevel: RiskLevel.High,
        subject: 'Notification',
        conditions: { householdId: '{{ unit.householdId }}' },
      },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'pending',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: true,
    });
  });

  it('a Granted unit-scope row over a CONDITION-FREE permission reports pending — nothing bounds it to the unit', async () => {
    // Mirrors the ability read path (#60): the grant confers nothing, and
    // it is NOT marked stale — re-consent cannot fix a structural gap.
    db.permission.findMany.mockResolvedValue([
      { slug: 'create:notification', riskLevel: RiskLevel.Low, subject: 'Notification', conditions: null },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'pending',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: false,
    });
  });

  describe('a Granted unit-scope row over a FIXED-CONDITION permission reports pending — fixed conditions bind no unit (#591)', () => {
    // A fixed filter reaches every matching row install-wide, so the read
    // path confers nothing, and re-consent cannot fix that: not stale.
    const USER_UNIT: PluginUnit = { scopeType: 'User', userId: 'u-1' };

    it.each([
      ['update:household:restore', 'household'],
      ['update:household:restore', 'user'],
      ['update:household:restore:administer', 'household'],
      ['update:household:restore:administer', 'user'],
      ['create:event', 'household'],
      ['create:event', 'user'],
    ] as const)('%s at %s scope', async (slug, consentScope) => {
      await expect(classifyGranted(slug, consentScope)).resolves.toEqual({
        decision: 'pending',
        decidedRiskLevel: RiskLevel.Low,
        staleRisk: false,
      });
    });

    it.each(['household', 'user'] as const)(
      'the same Granted row over an allowlisted public read confers at %s scope',
      async (consentScope) => {
        await expect(classifyGranted('read:game:public', consentScope)).resolves.toEqual({
          decision: 'granted',
          decidedRiskLevel: RiskLevel.Low,
          staleRisk: false,
        });
      },
    );

    /** One Granted Low row at the unit's own scope over `slug`, carrying its real catalog conditions. */
    async function classifyGranted(slug: string, consentScope: 'household' | 'user') {
      const entry = PERMISSION_CATALOG.find((permission) => permission.slug === slug);
      expect(entry).toBeDefined();
      db.permission.findMany.mockResolvedValue([
        { slug, riskLevel: RiskLevel.Low, subject: entry?.subject, conditions: entry?.conditions },
      ] as never);
      db.pluginGrant.findMany.mockResolvedValue([
        {
          permissionSlug: slug,
          scopeType: consentScope === 'household' ? PluginGrantScope.Household : PluginGrantScope.User,
          status: PluginGrantStatus.Granted,
          decidedRiskLevel: RiskLevel.Low,
        },
      ] as never);

      const result = await classifier.classify('plg_1', consentScope === 'household' ? HOUSEHOLD_UNIT : USER_UNIT, [
        check(slug, { consentScope }),
      ]);

      return result.decisions.get(slug);
    }
  });

  it('a subject drifted to the all wildcard demotes a Granted row to pending, NOT stale (the wildcard re-check)', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'create:notification', riskLevel: RiskLevel.Low, subject: 'all' },
    ] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'pending',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: false,
    });
  });

  it('a Granted row whose catalog row vanished confers nothing (mirrors the read path, not unitConsentSatisfied)', async () => {
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'create:notification',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [check('create:notification')]);

    expect(result.decisions.get('create:notification')).toEqual({
      decision: 'pending',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: false,
    });
    expect(result.currentRiskBySlug.has('create:notification')).toBe(false);
  });

  it('own-namespace risk is read fresh from the PluginPermission catalog, not assumed Low', async () => {
    db.pluginPermission.findMany.mockResolvedValue([{ slug: OWN_CANONICAL, riskLevel: RiskLevel.High }] as never);
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: OWN_CANONICAL,
        scopeType: PluginGrantScope.Server,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [
      check(OWN_CANONICAL, { consentScope: 'server', origin: 'plugin', slug: 'read:digest' }),
    ]);

    expect(result.decisions.get(OWN_CANONICAL)).toEqual({
      decision: 'pending',
      decidedRiskLevel: RiskLevel.Low,
      staleRisk: true,
    });
    expect(db.pluginPermission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ pluginId: 'plg_1' }) }),
    );
  });

  it('a row parked at the WRONG scope never answers for a check — decisions key on the deciding scope', async () => {
    db.permission.findMany.mockResolvedValue([
      { slug: 'feedback:read', riskLevel: RiskLevel.Low, subject: 'Feedback' },
    ] as never);
    // Server-consented check; the only row sits at Household scope.
    db.pluginGrant.findMany.mockResolvedValue([
      {
        permissionSlug: 'feedback:read',
        scopeType: PluginGrantScope.Household,
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.Low,
      },
    ] as never);

    const result = await classifier.classify('plg_1', HOUSEHOLD_UNIT, [
      check('feedback:read', { consentScope: 'server' }),
    ]);

    expect(result.decisions.get('feedback:read')).toEqual({
      decision: 'pending',
      decidedRiskLevel: null,
      staleRisk: false,
    });
  });
});
