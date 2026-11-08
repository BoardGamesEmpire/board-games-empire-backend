import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  PluginUnitDormantReason,
  RiskLevel,
} from '@bge/database';
import { createMockDatabaseService, UNIT_BOUND_RULES, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginConsentCheckClassifier } from '../consent/plugin-consent-check-classifier.service';
import { PluginConsentStandingService } from '../consent/plugin-consent-standing.service';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginUnitScopeError } from '../units/unit.errors';
import {
  PluginFeatureStateManifestError,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateTombstonedError,
} from './feature-state.errors';
import { PluginFeatureStateService } from './plugin-feature-state.service';

describe('PluginFeatureStateService', () => {
  const options = buildPluginModuleOptions();

  /**
   * Household-scope manifest exercising the full binding matrix:
   * - `manage:digest` — required, server-consented, NO feature (plugin-wide;
   *   must never appear in a feature's `blockingSlugs` / `perUnitSlugs`).
   * - weekly-digest ← `feedback:read` (core, server) + `create:notification`
   *   (core, household) — the issue's worked example.
   * - calendar-sync ← `update:calendar` (core, household) +
   *   `read:public_content` (core, user) — one feature spanning two unit
   *   axes, so scope-ownership filtering is observable.
   * - digest-insights ← `read:digest` (OWN-namespace, server) — the
   *   plugin-origin catalog path.
   * - status-badge ← no bound checks (nothing to consent).
   */
  const OWN_CANONICAL = 'plugin|demo-sink|read:digest';
  const MANAGE_CANONICAL = 'plugin|demo-sink|manage:digest';

  const manifest = buildPluginManifest({ scope: 'household' });
  manifest.features = [
    {
      name: 'weekly-digest',
      displayName: { en: 'Weekly digest', de: 'Wochenübersicht' },
      description: { en: 'Sends a weekly summary.', de: 'Sendet eine wöchentliche Zusammenfassung.' },
    },
    {
      name: 'calendar-sync',
      displayName: { en: 'Calendar sync' },
      description: { en: 'Mirrors game nights into the household calendar.' },
    },
    {
      name: 'digest-insights',
      displayName: { en: 'Digest insights' },
      description: { en: 'Aggregated statistics over stored digests.' },
    },
    {
      name: 'status-badge',
      displayName: { en: 'Status badge' },
      description: { en: 'Shows a passive status badge.' },
    },
  ];
  manifest.permissions.declares = ['manage:digest', 'read:digest'];
  manifest.permissions.checks = [
    {
      slug: 'manage:digest',
      required: true,
      reason: { en: 'Stores and manages the digest configuration it owns.' },
      consentScope: 'server',
    },
    {
      slug: 'feedback:read',
      required: false,
      reason: { en: 'Reads submitted feedback to compose the weekly digest.' },
      feature: 'weekly-digest',
      consentScope: 'server',
    },
    {
      slug: 'create:notification',
      required: false,
      reason: { en: 'Sends the weekly digest as a notification.' },
      feature: 'weekly-digest',
      consentScope: 'household',
    },
    {
      slug: 'update:calendar',
      // The household-scope required check: the one a household can itself
      // owe, so its risk_raised and never_asked kinds are reachable (#1149).
      required: true,
      reason: { en: 'Writes digest reminders to the household calendar.' },
      feature: 'calendar-sync',
      consentScope: 'household',
    },
    {
      slug: 'read:public_content',
      required: false,
      reason: { en: 'Shows public content excerpts inside per-user views.' },
      feature: 'calendar-sync',
      consentScope: 'user',
    },
    {
      slug: 'read:digest',
      required: false,
      reason: { en: 'Reads stored digests to compute aggregate insights.' },
      feature: 'digest-insights',
      consentScope: 'server',
    },
  ];

  const SERVER_UNIT: PluginUnit = { scopeType: 'Server' };
  const HOUSEHOLD_UNIT: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };
  const USER_UNIT: PluginUnit = { scopeType: 'User', userId: 'u-1' };

  const pluginRow = (
    overrides: Partial<{ enabled: boolean; uninstalledAt: Date | null; scope: PluginScope }> = {},
  ) => ({
    id: 'plg_1',
    slug: 'demo-sink',
    version: '1.2.0',
    enabled: true,
    scope: PluginScope.Household,
    uninstalledAt: null,
    manifestJson: manifest,
    ...overrides,
  });

  interface GrantRowInput {
    slug: string;
    scopeType?: PluginGrantScope;
    status?: PluginGrantStatus;
    decidedRiskLevel?: RiskLevel;
  }

  const grantRow = ({ slug, scopeType, status, decidedRiskLevel }: GrantRowInput) => ({
    permissionSlug: slug,
    scopeType: scopeType ?? PluginGrantScope.Household,
    status: status ?? PluginGrantStatus.Granted,
    decidedRiskLevel: decidedRiskLevel ?? RiskLevel.Low,
  });

  const riskRow = (slug: string, riskLevel: RiskLevel = RiskLevel.Low, subject?: string) => ({
    slug,
    riskLevel,
    // Unit-consented rows confer only when they name the consenting unit's
    // own id on a column that holds it (#60, #591, #994): the user's for the
    // one permission the manifest requests at user scope, the household's
    // otherwise.
    ...(slug === 'read:public_content' ? UNIT_BOUND_RULES.User : UNIT_BOUND_RULES.Household),
    ...(subject === undefined ? {} : { subject }),
  });

  /** Every bound core slug at Low — the catalog state the happy paths assume. */
  const allCoreRisks = [
    riskRow('feedback:read'),
    riskRow('create:notification'),
    riskRow('update:calendar'),
    riskRow('read:public_content'),
  ];

  /** Fully consented household unit: server + household grants all Low. */
  const householdHappyGrants = [
    grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
    grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
    grantRow({ slug: MANAGE_CANONICAL, scopeType: PluginGrantScope.Server }),
    grantRow({ slug: 'create:notification' }),
    grantRow({ slug: 'update:calendar' }),
  ];

  let db: MockDatabaseService;
  let service: PluginFeatureStateService;

  const featureByName = async (unit: PluginUnit, name: string, locale?: string) => {
    const result = await service.resolveForUnit('plg_1', unit, locale);
    const feature = result?.features.find((candidate) => candidate.name === name);

    if (!feature) {
      throw new Error(`feature '${name}' missing from result`);
    }

    return feature;
  };

  beforeEach(() => {
    db = createMockDatabaseService();
    db.plugin.findUnique.mockResolvedValue(pluginRow() as never);
    db.householdPlugin.findUnique.mockResolvedValue({ enabled: true } as never);
    db.userPlugin.findUnique.mockResolvedValue({ enabled: true } as never);
    db.pluginGrant.findMany.mockResolvedValue(householdHappyGrants as never);
    db.permission.findMany.mockResolvedValue(allCoreRisks as never);
    db.pluginPermission.findMany.mockResolvedValue([
      { slug: OWN_CANONICAL, riskLevel: RiskLevel.Low },
      { slug: MANAGE_CANONICAL, riskLevel: RiskLevel.Low },
    ] as never);

    const classifier = new PluginConsentCheckClassifier(db as unknown as DatabaseService);

    service = new PluginFeatureStateService(
      db as unknown as DatabaseService,
      new PluginConsentStandingService(classifier, options),
      options,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('returns null when no Plugin row exists', async () => {
    db.plugin.findUnique.mockResolvedValue(null as never);

    await expect(service.resolveForUnit('ghost', HOUSEHOLD_UNIT)).resolves.toBeNull();
  });

  it('rejects a structurally invalid unit at the boundary, before any query', async () => {
    await expect(service.resolveForUnit('plg_1', { scopeType: 'Household' } as unknown as PluginUnit)).rejects.toThrow(
      RangeError,
    );
    expect(db.plugin.findUnique).not.toHaveBeenCalled();
  });

  describe('resolveForUnitBySlug (the HTTP edge, #323)', () => {
    it('resolves the slug and hands back the id-addressed derivation', async () => {
      const result = await service.resolveForUnitBySlug('demo-sink', HOUSEHOLD_UNIT, 'de');

      expect(db.plugin.findUnique).toHaveBeenCalledWith({
        where: { slug: 'demo-sink' },
        select: { id: true, scope: true, uninstalledAt: true },
      });
      expect(result.plugin).toEqual({ id: 'plg_1', slug: 'demo-sink' });
      expect(result.served).toBe(true);
    });

    it('refuses a HOUSEHOLD viewpoint on a server-scope plugin — impossible unit state must not read as real', async () => {
      db.plugin.findUnique.mockResolvedValue(pluginRow({ scope: PluginScope.Server }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)).rejects.toBeInstanceOf(
        PluginUnitScopeError,
      );

      // The server viewpoint stays servable.
      await expect(service.resolveForUnitBySlug('demo-sink', SERVER_UNIT)).resolves.toMatchObject({
        plugin: { slug: 'demo-sink' },
      });
    });

    it('serves the USER viewpoint on a server-scope plugin — UserPlugin is a real surface at any plugin scope', async () => {
      // A user-consented check is permitted on a server-scope manifest
      // (#225) and a Granted decision creates the anchor this reads, which
      // the user's own enable/disable then toggles. Refusing the read would
      // leave them switching a unit whose blocked features they cannot see.
      db.plugin.findUnique.mockResolvedValue(pluginRow({ scope: PluginScope.Server }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', USER_UNIT)).resolves.toMatchObject({
        plugin: { slug: 'demo-sink' },
        unit: USER_UNIT,
      });
    });

    it('throws the typed 404 for an unknown slug — the edge cannot draw 404-vs-410 from a null', async () => {
      db.plugin.findUnique.mockResolvedValue(null as never);

      await expect(service.resolveForUnitBySlug('ghost', HOUSEHOLD_UNIT)).rejects.toBeInstanceOf(
        PluginFeatureStateNotFoundError,
      );
    });

    it('throws the typed 410 for a tombstone, where the id-addressed read short-circuits to served-false', async () => {
      const uninstalledAt = new Date('2026-08-01T00:00:00.000Z');
      db.plugin.findUnique.mockResolvedValue(pluginRow({ uninstalledAt }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)).rejects.toMatchObject({
        constructor: PluginFeatureStateTombstonedError,
        uninstalledAt,
      });

      // The in-process contract is unchanged: same tombstone, no throw.
      await expect(service.resolveForUnit('plg_1', HOUSEHOLD_UNIT)).resolves.toMatchObject({
        served: false,
        features: [],
      });
    });

    it('refuses a scope narrowing that lands AFTER the derivation, which would otherwise serve a household unit', async () => {
      // Activation retires no household rows, so the retained row still
      // reads enabled and the derivation would answer served:true for a
      // surface the scope rule says cannot exist. The opening guard cannot
      // see it — it read the row before the activation committed.
      db.plugin.findUnique
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow({ scope: PluginScope.Server }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)).rejects.toBeInstanceOf(
        PluginUnitScopeError,
      );

      // Three reads: the guard that fired is the CLOSING one, so the
      // derivation genuinely ran and was discarded rather than skipped.
      expect(db.plugin.findUnique).toHaveBeenCalledTimes(3);
      expect(db.plugin.findUnique).toHaveBeenLastCalledWith({
        where: { id: 'plg_1' },
        select: { scope: true, uninstalledAt: true },
      });
    });

    it('refuses an uninstall that lands AFTER the derivation, so the promised 410 is not downgraded to served-false', async () => {
      const uninstalledAt = new Date('2026-08-02T00:00:00.000Z');
      db.plugin.findUnique
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow({ uninstalledAt }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)).rejects.toMatchObject({
        constructor: PluginFeatureStateTombstonedError,
        uninstalledAt,
      });
    });

    it('the USER viewpoint is unaffected by a scope narrowing — UserPlugin is a real surface at any scope', async () => {
      db.plugin.findUnique
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow() as never)
        .mockResolvedValueOnce(pluginRow({ scope: PluginScope.Server }) as never);

      await expect(service.resolveForUnitBySlug('demo-sink', USER_UNIT)).resolves.toMatchObject({
        unit: USER_UNIT,
      });
    });
  });

  describe('derivation', () => {
    it('reports every feature active for a fully consented, served household unit', async () => {
      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, state: 'on' });
      expect(result?.features).toEqual([
        expect.objectContaining({ name: 'weekly-digest', state: 'active', reason: null, blockingSlugs: [] }),
        expect.objectContaining({ name: 'calendar-sync', state: 'active', reason: null, blockingSlugs: [] }),
        expect.objectContaining({ name: 'digest-insights', state: 'active', reason: null, blockingSlugs: [] }),
        expect.objectContaining({ name: 'status-badge', state: 'active', reason: null, blockingSlugs: [] }),
      ]);
    });

    it('marks the bound feature disabled with reason denied when an optional permission is denied', async () => {
      // The issue's worked example: deny `create:notification` → the
      // 'weekly-digest' feature is disabled; other features are untouched.
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'create:notification', status: PluginGrantStatus.Denied }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result?.features).toEqual([
        expect.objectContaining({
          name: 'weekly-digest',
          state: 'disabled',
          reason: 'denied',
          blockingSlugs: ['create:notification'],
        }),
        expect.objectContaining({ name: 'calendar-sync', state: 'active' }),
        expect.objectContaining({ name: 'digest-insights', state: 'active' }),
        expect.objectContaining({ name: 'status-badge', state: 'active' }),
      ]);
    });

    it('distinguishes never-asked from denied: a missing row reports pending', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: ['create:notification'] });
    });

    it('a server-scope denial dead-ends the feature for every unit, reading denied from a household (#1149)', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server, status: PluginGrantStatus.Denied }),
        grantRow({ slug: 'create:notification' }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);
      const feature = result?.features.find((entry) => entry.name === 'weekly-digest');

      // The refusal is durable, so the feature is not waiting on anyone: it
      // reads denied. That the household cannot reverse it is the check's
      // kind under consent, outstanding_elsewhere (#1149).
      expect(feature).toMatchObject({ state: 'disabled', reason: 'denied', blockingSlugs: ['feedback:read'] });
      expect(result?.consent.optionalOff).toContainEqual(
        expect.objectContaining({ slug: 'feedback:read', kind: 'outstanding_elsewhere' }),
      );
    });

    it('a grant whose decided risk no longer covers current risk reports pending — consent must be re-given', async () => {
      db.permission.findMany.mockResolvedValue([
        riskRow('feedback:read'),
        riskRow('create:notification', RiskLevel.High),
        riskRow('update:calendar'),
        riskRow('read:public_content'),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: ['create:notification'] });
    });

    it('a granted check whose catalog row vanished reports pending, never satisfied', async () => {
      db.permission.findMany.mockResolvedValue([
        riskRow('feedback:read'),
        riskRow('update:calendar'),
        riskRow('read:public_content'),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: ['create:notification'] });
    });

    it('a feature with no bound checks is active — nothing to consent to', async () => {
      db.pluginGrant.findMany.mockResolvedValue([] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'status-badge');

      expect(feature).toMatchObject({ state: 'active', reason: null, blockingSlugs: [] });
    });

    it('a core subject drifted to the all wildcard reports pending — the same re-check the ability applies', async () => {
      db.permission.findMany.mockResolvedValue([
        riskRow('feedback:read'),
        riskRow('create:notification', RiskLevel.Low, 'all'),
        riskRow('update:calendar'),
        riskRow('read:public_content'),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: ['create:notification'] });
    });

    it('an own-namespace grant with stale decided risk reports pending against the PluginPermission catalog', async () => {
      db.pluginPermission.findMany.mockResolvedValue([{ slug: OWN_CANONICAL, riskLevel: RiskLevel.High }] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'digest-insights');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: [OWN_CANONICAL] });
      expect(db.pluginPermission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ pluginId: 'plg_1' }) }),
      );
    });
  });

  describe('consent standing (#1149)', () => {
    it('a unit still owing a required check is served, with state review_pending and the slug under consent.outstanding (#1149)', async () => {
      // The required, server-consented manage:digest has no grant. Before
      // #1149 this suspended the unit (#1061, #1063); now it keeps running on
      // what it was given and the state code says what is waiting.
      db.pluginGrant.findMany.mockResolvedValue(
        householdHappyGrants.filter((grant) => grant.permissionSlug !== MANAGE_CANONICAL) as never,
      );

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, state: 'review_pending' });
      expect(result?.consent.outstanding.map((check) => check.slug)).toEqual([MANAGE_CANONICAL]);
      expect(result?.consent.optionalOff).toEqual([]);
    });

    it('a fully consented enabled unit reads on (#1149)', async () => {
      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({
        served: true,
        serverEnabled: true,
        state: 'on',
        consent: { outstanding: [], optionalOff: [] },
      });
    });

    it('a household unit whose plugin a server admin switched off reads unavailable, not on (#1149)', async () => {
      // Nothing runs for anyone while the server switch is off, so a code
      // that said `on` would mislead a client announcing the code alone. The
      // household's own switch is not the one that is off, so it is not
      // `off` either; serverEnabled says which cause unavailable has.
      db.plugin.findUnique.mockResolvedValue(pluginRow({ enabled: false }) as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, serverEnabled: false, state: 'unavailable' });
    });

    it('the Server unit reads off when the server switch is off: that switch is its own (#1149)', async () => {
      db.plugin.findUnique.mockResolvedValue(pluginRow({ enabled: false }) as never);

      const result = await service.resolveForUnit('plg_1', SERVER_UNIT);

      expect(result).toMatchObject({ served: false, serverEnabled: false, state: 'off' });
    });

    it('a Granted row at a risk the catalog has since raised reads review_pending and stays served (#1149)', async () => {
      db.permission.findMany.mockResolvedValue([
        riskRow('feedback:read'),
        riskRow('create:notification'),
        riskRow('update:calendar', RiskLevel.High),
        riskRow('read:public_content'),
      ] as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, state: 'review_pending' });
      expect(result?.consent.outstanding).toEqual([
        expect.objectContaining({ slug: 'update:calendar', kind: 'risk_raised', required: true }),
      ]);
    });

    it('a server-consented required check with a raised risk reads outstanding_elsewhere from a household (#1149)', async () => {
      // Seen from a household, a server-consented check is the server admin's
      // to answer, so the unit is told the cure lies elsewhere.
      db.pluginPermission.findMany.mockResolvedValue([
        { slug: OWN_CANONICAL, riskLevel: RiskLevel.Low },
        { slug: MANAGE_CANONICAL, riskLevel: RiskLevel.High },
      ] as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, state: 'review_pending' });
      expect(result?.consent.outstanding).toEqual([
        expect.objectContaining({ slug: MANAGE_CANONICAL, kind: 'outstanding_elsewhere' }),
      ]);
    });

    it('a refused optional check switches its feature off without holding the unit in review (#1149)', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        ...householdHappyGrants.filter((grant) => grant.permissionSlug !== 'create:notification'),
        grantRow({ slug: 'create:notification', status: PluginGrantStatus.Denied }),
      ] as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, state: 'on' });
      expect(result?.consent.optionalOff.map((check) => check.slug)).toEqual(['create:notification']);
    });
  });

  describe('serving vs consent separation (#1149)', () => {
    it('a missing household enablement row is not served, but consent-derived states stand', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, state: 'off' });
      expect(result?.features.every((feature) => feature.state === 'active')).toBe(true);
    });

    /**
     * The third component of the predicate (#369). A dormant row is enabled
     * and the household asked for nothing, so without this the read answers
     * `served: true` for a unit the manifest moved out from under.
     */
    it.each<[string, PluginUnitDormantReason, string]>([
      ['needs_configuration', PluginUnitDormantReason.NeedsConfiguration, 'needs_configuration'],
      ['unavailable', PluginUnitDormantReason.ScopeOrphaned, 'unavailable'],
    ])('a dormant row reads %s from dormantReason, with served false', async (_label, dormantReason, state) => {
      db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, dormantReason } as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, state });
      // Dormancy is not a consent state: the features keep the states their
      // grants earned, exactly as for a switched-off unit.
      expect(result?.features.every((feature) => feature.state === 'active')).toBe(true);
    });

    it.each<[string, PluginUnitDormantReason]>([
      ['needs_configuration', PluginUnitDormantReason.NeedsConfiguration],
      ['unavailable', PluginUnitDormantReason.ScopeOrphaned],
    ])(
      'a dormant row that also owes a required check still reads %s, not review_pending',
      async (state, dormantReason) => {
        db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, dormantReason } as never);
        db.pluginGrant.findMany.mockResolvedValue(
          householdHappyGrants.filter((grant) => grant.permissionSlug !== 'update:calendar') as never,
        );

        const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

        expect(result?.consent.outstanding.length).toBeGreaterThan(0);
        expect(result).toMatchObject({ served: false, state });
      },
    );

    it('never reads dormant on the user axis — user consent is legal at any plugin scope (#225)', async () => {
      const result = await service.resolveForUnit('plg_1', USER_UNIT);

      // The default grants cover every check a user unit consumes.
      expect(result?.state).toBe('on');
    });

    it('is not served when the plugin is disabled', async () => {
      db.plugin.findUnique.mockResolvedValue(pluginRow({ enabled: false }) as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false });
    });

    it('the tombstone short-circuit returns served false, state off and empty consent lists (#1149)', async () => {
      db.plugin.findUnique.mockResolvedValue(pluginRow({ uninstalledAt: new Date('2026-08-01T00:00:00Z') }) as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({
        served: false,
        state: 'off',
        consent: { outstanding: [], optionalOff: [] },
        features: [],
      });
    });
  });

  describe('scope ownership mirrors the ability read path (#60)', () => {
    it('queries grants at the Server sentinel plus the unit coordinates, for every consumed check', async () => {
      await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pluginId: 'plg_1',
            OR: [
              { scopeType: PluginGrantScope.Server, scopeId: '' },
              { scopeType: PluginGrantScope.Household, scopeId: 'hh-1' },
            ],
            // The feature-less required check enters through the consent standing
            // (#1149), and user-consented checks are not consumed by a household unit.
            permissionSlug: {
              in: [MANAGE_CANONICAL, 'feedback:read', 'create:notification', 'update:calendar', OWN_CANONICAL],
            },
          }),
        }),
      );
    });

    it('derives a user unit from server + user-consented checks only', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'read:public_content', scopeType: PluginGrantScope.User }),
      ] as never);

      const result = await service.resolveForUnit('plg_1', USER_UNIT);

      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { scopeType: PluginGrantScope.Server, scopeId: '' },
              { scopeType: PluginGrantScope.User, scopeId: 'u-1' },
            ],
            permissionSlug: { in: [MANAGE_CANONICAL, 'feedback:read', 'read:public_content', OWN_CANONICAL] },
          }),
        }),
      );
      // calendar-sync for a USER unit consumes only its user-consented check;
      // the household-consented `update:calendar` belongs to household units
      // and is reported per-unit, not silently folded into this unit's green.
      expect(result?.features).toEqual([
        expect.objectContaining({ name: 'weekly-digest', state: 'active', perUnitSlugs: ['create:notification'] }),
        expect.objectContaining({ name: 'calendar-sync', state: 'active', perUnitSlugs: ['update:calendar'] }),
        expect.objectContaining({ name: 'digest-insights', state: 'active', perUnitSlugs: [] }),
        expect.objectContaining({ name: 'status-badge', state: 'active', perUnitSlugs: [] }),
      ]);
    });

    it('derives a Server unit from server-consented checks only, with the sentinel-only scope filter', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
      ] as never);

      const result = await service.resolveForUnit('plg_1', SERVER_UNIT);

      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ scopeType: PluginGrantScope.Server, scopeId: '' }],
            // Household- and user-consented checks are other axes' decisions;
            // a Server unit must not consume (or widen into) them.
            permissionSlug: { in: [MANAGE_CANONICAL, 'feedback:read', OWN_CANONICAL] },
          }),
        }),
      );
      // No enablement row exists for Server units — no lookup happens.
      expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
      expect(db.userPlugin.findUnique).not.toHaveBeenCalled();
      // weekly-digest's only server-owned check is granted; calendar-sync has
      // no server-owned checks at all. Both derive active FOR THIS UNIT —
      // active means no gate this unit's resolution owns blocks them — and
      // every cross-axis check is named in perUnitSlugs so the viewpoint
      // cannot read as a fleet-wide green: calendar-sync's activation is
      // entirely per-unit business (the consent surface models the same
      // checks as `per-unit`), and #67's degraded-mode answer must ask the
      // owning units.
      expect(result).toMatchObject({ served: true });
      expect(result?.features).toEqual([
        expect.objectContaining({ name: 'weekly-digest', state: 'active', perUnitSlugs: ['create:notification'] }),
        expect.objectContaining({
          name: 'calendar-sync',
          state: 'active',
          perUnitSlugs: ['read:public_content', 'update:calendar'],
        }),
        expect.objectContaining({ name: 'digest-insights', state: 'active', perUnitSlugs: [] }),
        expect.objectContaining({ name: 'status-badge', state: 'active', perUnitSlugs: [] }),
      ]);
    });

    it('a satisfying grant at the WRONG scope does not satisfy a check (deciding scope only)', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        // Household-consented check "granted" at Server scope — not its
        // deciding scope, so it confers nothing here.
        grantRow({ slug: 'create:notification', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'pending', blockingSlugs: ['create:notification'] });
    });
  });

  describe('localization', () => {
    it('resolves feature names and descriptions for the requested locale', async () => {
      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest', 'de');

      expect(feature.displayName).toBe('Wochenübersicht');
      expect(feature.description).toBe('Sendet eine wöchentliche Zusammenfassung.');
    });

    it('falls back through the manifest chain when the requested locale is missing', async () => {
      // calendar-sync carries only `en`; a `de` request falls back.
      const feature = await featureByName(HOUSEHOLD_UNIT, 'calendar-sync', 'de');

      expect(feature.displayName).toBe('Calendar sync');
    });

    it('falls back to the host default for an unsupported locale', async () => {
      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest', 'fr-FR');

      expect(feature.displayName).toBe('Weekly digest');
    });

    it('uses the host default locale when none is requested', async () => {
      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature.displayName).toBe('Weekly digest');
    });
  });

  describe('stored-manifest distrust', () => {
    it('throws the typed error when the row slug disagrees with the manifest', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...pluginRow(), slug: 'other-plugin' } as never);

      await expect(service.resolveForUnit('plg_1', HOUSEHOLD_UNIT)).rejects.toThrow(PluginFeatureStateManifestError);
    });

    it('throws the typed error when the stored manifest no longer validates', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...pluginRow(), manifestJson: { not: 'a manifest' } } as never);

      await expect(service.resolveForUnit('plg_1', HOUSEHOLD_UNIT)).rejects.toThrow(PluginFeatureStateManifestError);
    });

    it('a tombstoned plugin short-circuits BEFORE manifest validation — uninstalled is not an error', async () => {
      db.plugin.findUnique.mockResolvedValue({
        ...pluginRow({ uninstalledAt: new Date('2026-08-01T00:00:00Z') }),
        manifestJson: { not: 'a manifest' }, // stale/broken — must never be parsed
      } as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, features: [] });
      expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
    });
  });
});
