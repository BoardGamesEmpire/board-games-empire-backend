import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  PluginUnitDormantReason,
  RiskLevel,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginConsentCheckClassifier } from '../consent/plugin-consent-check-classifier.service';
import type { PluginModuleOptions } from '../plugin-module.options';
import { PluginUnitScopeError } from '../units/unit.errors';
import {
  PluginFeatureStateManifestError,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateTombstonedError,
} from './feature-state.errors';
import { PluginFeatureStateService } from './plugin-feature-state.service';

describe('PluginFeatureStateService', () => {
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  /**
   * Household-scope manifest exercising the full binding matrix:
   * - `manage:digest` — required, server-consented, NO feature (plugin-wide;
   *   must never appear in feature derivation or the grant query).
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
      required: false,
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

  const riskRow = (slug: string, riskLevel: RiskLevel = RiskLevel.Low, subject = 'Game') => ({
    slug,
    riskLevel,
    subject,
    // Unit-consented rows confer only when they carry a bounding clause
    // (#60); a realistic template keeps these fixtures conferring.
    conditions: { householdId: '{{ unit.householdId }}' },
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
    db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, suspendedForConsent: false } as never);
    db.userPlugin.findUnique.mockResolvedValue({ enabled: true, suspendedForConsent: false } as never);
    db.pluginGrant.findMany.mockResolvedValue(householdHappyGrants as never);
    db.permission.findMany.mockResolvedValue(allCoreRisks as never);
    db.pluginPermission.findMany.mockResolvedValue([{ slug: OWN_CANONICAL, riskLevel: RiskLevel.Low }] as never);

    service = new PluginFeatureStateService(
      db as unknown as DatabaseService,
      new PluginConsentCheckClassifier(db as unknown as DatabaseService),
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

      expect(result).toMatchObject({ served: true, suspendedForConsent: false });
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

    it('a server-scope denial dead-ends the feature for every unit', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server, status: PluginGrantStatus.Denied }),
        grantRow({ slug: 'create:notification' }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'denied', blockingSlugs: ['feedback:read'] });
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

  describe('suspension', () => {
    it('reports consent-complete features disabled with reason suspended while the unit is consent-suspended', async () => {
      db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, suspendedForConsent: true } as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, suspendedForConsent: true });
      expect(result?.features).toEqual([
        expect.objectContaining({ name: 'weekly-digest', state: 'disabled', reason: 'suspended', blockingSlugs: [] }),
        expect.objectContaining({ name: 'calendar-sync', state: 'disabled', reason: 'suspended' }),
        expect.objectContaining({ name: 'digest-insights', state: 'disabled', reason: 'suspended' }),
        expect.objectContaining({ name: 'status-badge', state: 'disabled', reason: 'suspended' }),
      ]);
    });

    it('an actionable consent state outranks suspension in the reason slot', async () => {
      db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, suspendedForConsent: true } as never);
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'create:notification', status: PluginGrantStatus.Denied }),
        grantRow({ slug: 'update:calendar' }),
      ] as never);

      const feature = await featureByName(HOUSEHOLD_UNIT, 'weekly-digest');

      expect(feature).toMatchObject({ state: 'disabled', reason: 'denied', blockingSlugs: ['create:notification'] });
    });
  });

  describe('serving vs consent separation', () => {
    it('a missing household enablement row is not served, but consent-derived states stand', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false, suspendedForConsent: false });
      expect(result?.features.every((feature) => feature.state === 'active')).toBe(true);
    });

    /**
     * The third component of the predicate (#369, D-CK). A dormant row is
     * enabled and unsuspended — the household asked for nothing — so without
     * this the read answers `served: true` for a unit the manifest moved out
     * from under.
     */
    it('a dormant row is not served, and the read says why', async () => {
      db.householdPlugin.findUnique.mockResolvedValue({
        enabled: true,
        suspendedForConsent: false,
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
      } as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({
        served: false,
        suspendedForConsent: false,
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
      });
      // Dormancy is not a consent state: the features keep the states their
      // grants earned, exactly as for a switched-off unit.
      expect(result?.features.every((feature) => feature.state === 'active')).toBe(true);
    });

    it('reports no dormancy for an ordinary served unit', async () => {
      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: true, dormantReason: null });
    });

    it('never reports dormancy on the user axis — user consent is legal at any plugin scope (#225)', async () => {
      const result = await service.resolveForUnit('plg_1', USER_UNIT);

      expect(result?.dormantReason).toBeNull();
    });

    it.each<[string, Partial<{ enabled: boolean; uninstalledAt: Date | null }>]>([
      ['the plugin is disabled', { enabled: false }],
      ['the plugin is tombstoned', { uninstalledAt: new Date('2026-08-01T00:00:00Z') }],
    ])('is not served when %s', async (_label, overrides) => {
      db.plugin.findUnique.mockResolvedValue(pluginRow(overrides) as never);

      const result = await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(result).toMatchObject({ served: false });
    });
  });

  describe('scope ownership mirrors the ability read path (#60)', () => {
    it('queries grants at the Server sentinel plus the unit coordinates, for bound checks only', async () => {
      await service.resolveForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pluginId: 'plg_1',
            OR: [
              { scopeType: PluginGrantScope.Server, scopeId: '' },
              { scopeType: PluginGrantScope.Household, scopeId: 'hh-1' },
            ],
            // The feature-less required check never enters feature derivation,
            // and user-consented checks are not consumed by a household unit.
            permissionSlug: { in: ['feedback:read', 'create:notification', 'update:calendar', OWN_CANONICAL] },
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
            permissionSlug: { in: ['feedback:read', 'read:public_content', OWN_CANONICAL] },
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
            permissionSlug: { in: ['feedback:read', OWN_CANONICAL] },
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
      expect(result).toMatchObject({ served: true, suspendedForConsent: false });
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
