import type { PluginUnit } from '@bge/actor-context';
import { DatabaseService, PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import { createMockDatabaseService, UNIT_BOUND_RULES, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PluginConsentPresentationManifestError,
  PluginConsentPresentationNoStagedUpdateError,
  PluginConsentPresentationNotFoundError,
  PluginConsentPresentationTombstonedError,
} from './consent-presentation.errors';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import { PluginConsentPresentationService } from './plugin-consent-presentation.service';

describe('PluginConsentPresentationService', () => {
  const options = buildPluginModuleOptions();

  const OWN_CANONICAL = 'plugin|demo-sink|manage:digest';

  /**
   * Household-scope manifest exercising the presentation matrix: one
   * own-namespace server check (with a German reason for the exact-hit
   * locale case), one core server check bound to a feature, one core
   * household check (the unit's own to decide), and one core user check
   * (per-unit from every other viewpoint).
   */
  const manifest = buildPluginManifest({ scope: 'household' });
  manifest.permissions.declares = ['manage:digest'];
  manifest.permissions.checks = [
    {
      slug: 'manage:digest',
      required: true,
      reason: { en: 'Owns the digest data.', de: 'Verwaltet die Digest-Daten.' },
      consentScope: 'server',
    },
    {
      slug: 'feedback:read',
      required: false,
      reason: { en: 'Reads feedback to compose the digest.' },
      feature: 'weekly-digest',
      consentScope: 'server',
    },
    {
      slug: 'create:notification',
      required: false,
      reason: { en: 'Sends the digest as a notification.' },
      feature: 'weekly-digest',
      consentScope: 'household',
    },
    {
      slug: 'read:public_content',
      required: false,
      reason: { en: 'Shows public excerpts in per-user views.' },
      consentScope: 'user',
    },
  ];

  const SERVER_UNIT: PluginUnit = { scopeType: 'Server' };
  const HOUSEHOLD_UNIT: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };

  const INSTALLED_SHA = 'a'.repeat(64);
  const STAGED_SHA = 'b'.repeat(64);

  const pluginRow = (
    overrides: Partial<{
      enabled: boolean;
      uninstalledAt: Date | null;
      manifestJson: unknown;
      pendingVersion: string | null;
      pendingManifestJson: unknown;
      pendingSha256: string | null;
    }> = {},
  ) => ({
    id: 'plg_1',
    slug: 'demo-sink',
    version: '1.2.0',
    enabled: true,
    uninstalledAt: null,
    manifestJson: manifest,
    installedSha256: INSTALLED_SHA,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    ...overrides,
  });

  const grantRow = (input: {
    slug: string;
    scopeType?: PluginGrantScope;
    status?: PluginGrantStatus;
    decidedRiskLevel?: RiskLevel;
  }) => ({
    permissionSlug: input.slug,
    scopeType: input.scopeType ?? PluginGrantScope.Household,
    status: input.status ?? PluginGrantStatus.Granted,
    decidedRiskLevel: input.decidedRiskLevel ?? RiskLevel.Low,
  });

  /** The install-seeded state: both server checks Granted, unit scopes undecided. */
  const seededServerGrants = [
    grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
    grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server }),
  ];

  const coreCatalog = [
    { slug: 'feedback:read', riskLevel: RiskLevel.Low, subject: 'Feedback' },
    {
      slug: 'create:notification',
      riskLevel: RiskLevel.Medium,
      ...UNIT_BOUND_RULES.Household,
    },
    {
      slug: 'read:public_content',
      riskLevel: RiskLevel.Low,
      ...UNIT_BOUND_RULES.User,
    },
  ];

  let db: MockDatabaseService;
  let service: PluginConsentPresentationService;

  const checkBySlug = async (unit: PluginUnit, slug: string, locale?: string) => {
    const presentation = await service.presentForUnit('plg_1', unit, locale);
    const check = presentation?.checks.find((candidate) => candidate.slug === slug);

    if (!check) {
      throw new Error(`check '${slug}' missing from presentation`);
    }

    return check;
  };

  beforeEach(() => {
    db = createMockDatabaseService();
    db.plugin.findUnique.mockResolvedValue(pluginRow() as never);
    db.pluginGrant.findMany.mockResolvedValue(seededServerGrants as never);
    db.permission.findMany.mockResolvedValue(coreCatalog as never);
    db.pluginPermission.findMany.mockResolvedValue([{ slug: OWN_CANONICAL, riskLevel: RiskLevel.Low }] as never);

    service = new PluginConsentPresentationService(
      db as unknown as DatabaseService,
      new PluginConsentCheckClassifier(db as unknown as DatabaseService),
      options,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('returns null when no Plugin row exists', async () => {
    db.plugin.findUnique.mockResolvedValue(null as never);

    await expect(service.presentForUnit('ghost', SERVER_UNIT)).resolves.toBeNull();
  });

  it('returns null for a tombstoned plugin BEFORE touching the stored manifest — no consent surface exists', async () => {
    db.plugin.findUnique.mockResolvedValue(
      pluginRow({ uninstalledAt: new Date('2026-08-01T00:00:00Z'), manifestJson: { corrupted: true } }) as never,
    );

    await expect(service.presentForUnit('plg_1', SERVER_UNIT)).resolves.toBeNull();
  });

  it('rejects a structurally invalid unit at the boundary, before any query', async () => {
    await expect(service.presentForUnit('plg_1', { scopeType: 'Household' } as unknown as PluginUnit)).rejects.toThrow(
      RangeError,
    );
    expect(db.plugin.findUnique).not.toHaveBeenCalled();
  });

  it('wraps an invalid stored manifest in the presentation-surface error', async () => {
    db.plugin.findUnique.mockResolvedValue(pluginRow({ manifestJson: { nonsense: true } }) as never);

    await expect(service.presentForUnit('plg_1', SERVER_UNIT)).rejects.toThrow(PluginConsentPresentationManifestError);
  });

  /**
   * The slug-addressed entry point for the HTTP edge (D-BO, #322): same
   * assembly as `presentForUnit`, but the missing/tombstoned states THROW —
   * the edge owes D-AY's 404/410 distinction, which the id-addressed form's
   * null-for-both contract cannot feed.
   */
  describe('presentForUnitBySlug (D-BO, #322)', () => {
    it('loads by slug and assembles the same active-manifest surface', async () => {
      const presentation = await service.presentForUnitBySlug('demo-sink', SERVER_UNIT);

      expect(db.plugin.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: 'demo-sink' } }));
      expect(presentation.plugin).toEqual({ id: 'plg_1', slug: 'demo-sink', enabled: true });
      expect(presentation.source).toBe('active');
      expect(presentation.checks.length).toBeGreaterThan(0);
    });

    it('throws the typed not-found error for an unknown slug', async () => {
      db.plugin.findUnique.mockResolvedValue(null as never);

      const failure = await service.presentForUnitBySlug('ghost', SERVER_UNIT).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginConsentPresentationNotFoundError);
      expect(failure).toMatchObject({ pluginSlug: 'ghost' });
    });

    it('throws the typed tombstone error BEFORE touching the stored manifest — a 410, never a 404 or a 5xx', async () => {
      const uninstalledAt = new Date('2026-08-01T00:00:00Z');
      db.plugin.findUnique.mockResolvedValue(pluginRow({ uninstalledAt, manifestJson: { corrupted: true } }) as never);

      const failure = await service.presentForUnitBySlug('demo-sink', SERVER_UNIT).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginConsentPresentationTombstonedError);
      expect(failure).toMatchObject({ pluginSlug: 'demo-sink', uninstalledAt });
    });

    it('rejects a structurally invalid unit at the boundary, before any query', async () => {
      await expect(
        service.presentForUnitBySlug('demo-sink', { scopeType: 'User' } as unknown as PluginUnit),
      ).rejects.toThrow(RangeError);
      expect(db.plugin.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('the install/update response viewpoint (Server unit)', () => {
    it('presents every check in manifest order: server decisions concrete, unit-scope checks per-unit with risk shown', async () => {
      const presentation = await service.presentForUnit('plg_1', SERVER_UNIT);

      expect(presentation).toMatchObject({
        plugin: { id: 'plg_1', slug: 'demo-sink', enabled: true },
        manifestVersion: '1.2.0',
        source: 'active',
        unit: SERVER_UNIT,
      });
      // The manifest's features ride along, localized — the grouping context
      // for the checks carrying their names.
      expect(presentation?.features).toEqual([
        expect.objectContaining({
          name: 'weekly-digest',
          displayName: { value: 'Weekly digest', locale: 'en', usedFallback: false },
        }),
      ]);
      expect(presentation?.checks).toEqual([
        expect.objectContaining({
          slug: OWN_CANONICAL,
          origin: 'plugin',
          required: true,
          consentScope: 'server',
          feature: null,
          decidableByUnit: true,
          decision: 'granted',
          riskLevel: RiskLevel.Low,
          decidedRiskLevel: RiskLevel.Low,
          staleRisk: false,
        }),
        expect.objectContaining({
          slug: 'feedback:read',
          origin: 'core',
          feature: 'weekly-digest',
          decidableByUnit: true,
          decision: 'granted',
        }),
        expect.objectContaining({
          slug: 'create:notification',
          consentScope: 'household',
          decidableByUnit: false,
          decision: 'per-unit',
          riskLevel: RiskLevel.Medium,
          decidedRiskLevel: null,
          staleRisk: false,
        }),
        expect.objectContaining({
          slug: 'read:public_content',
          consentScope: 'user',
          decidableByUnit: false,
          decision: 'per-unit',
          riskLevel: RiskLevel.Low,
        }),
      ]);
    });

    it('a server-scope denial is durable, never per-unit', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        grantRow({ slug: OWN_CANONICAL, scopeType: PluginGrantScope.Server }),
        grantRow({ slug: 'feedback:read', scopeType: PluginGrantScope.Server, status: PluginGrantStatus.Denied }),
      ] as never);

      const check = await checkBySlug(SERVER_UNIT, 'feedback:read');

      expect(check).toMatchObject({ decision: 'denied', decidedRiskLevel: RiskLevel.Low });
    });
  });

  describe('the unit consent screen viewpoint (Household unit)', () => {
    it('marks the household check decidable and pending while server context stays visible but not decidable', async () => {
      const presentation = await service.presentForUnit('plg_1', HOUSEHOLD_UNIT);

      expect(presentation?.checks).toEqual([
        expect.objectContaining({ slug: OWN_CANONICAL, decidableByUnit: false, decision: 'granted' }),
        expect.objectContaining({ slug: 'feedback:read', decidableByUnit: false, decision: 'granted' }),
        expect.objectContaining({ slug: 'create:notification', decidableByUnit: true, decision: 'pending' }),
        expect.objectContaining({ slug: 'read:public_content', decidableByUnit: false, decision: 'per-unit' }),
      ]);
    });

    it('reflects the household own decisions: granted, denied, and stale-risk pending', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        ...seededServerGrants,
        // Granted at Low; the catalog now says Medium — consent must be re-made.
        grantRow({ slug: 'create:notification', decidedRiskLevel: RiskLevel.Low }),
      ] as never);

      const check = await checkBySlug(HOUSEHOLD_UNIT, 'create:notification');

      expect(check).toMatchObject({
        decision: 'pending',
        staleRisk: true,
        decidedRiskLevel: RiskLevel.Low,
        riskLevel: RiskLevel.Medium,
      });
    });

    it('a durable household denial presents as denied', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        ...seededServerGrants,
        grantRow({ slug: 'create:notification', status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Medium }),
      ] as never);

      const check = await checkBySlug(HOUSEHOLD_UNIT, 'create:notification');

      expect(check).toMatchObject({ decision: 'denied', staleRisk: false });
    });
  });

  describe('localization (explicit locale param, manifest fallback chain)', () => {
    it('no locale resolves at the host default without fallback for default-locale entries', async () => {
      const presentation = await service.presentForUnit('plg_1', SERVER_UNIT);

      expect(presentation?.displayName).toEqual({ value: 'Demo Sink', locale: 'en', usedFallback: false });
      // The fixture description is a bare string — shorthand for the default locale.
      expect(presentation?.description).toMatchObject({ value: expect.any(String), usedFallback: false });
    });

    it('an exact locale hit carries no fallback flag', async () => {
      const presentation = await service.presentForUnit('plg_1', SERVER_UNIT, 'de');

      expect(presentation?.displayName).toEqual({ value: 'Demo-Senke', locale: 'de', usedFallback: false });

      const own = presentation?.checks.find((check) => check.slug === OWN_CANONICAL);
      expect(own?.reason).toEqual({ value: 'Verwaltet die Digest-Daten.', locale: 'de', usedFallback: false });
    });

    it('a locale with no entry falls back to the default and SAYS so', async () => {
      const check = await checkBySlug(SERVER_UNIT, 'feedback:read', 'de');

      expect(check.reason).toEqual({
        value: 'Reads feedback to compose the digest.',
        locale: 'en',
        usedFallback: true,
      });
    });

    it('reports the one locale it was rendered in, apart from the locale each reason came from (#1301)', async () => {
      // A consent write sends this back, so the act records the text read.
      // The plugin has no German reason for feedback:read: that reason falls
      // back to English, and the surface is still the German one.
      const german = await service.presentForUnit('plg_1', SERVER_UNIT, 'de');
      const feedback = german?.checks.find((check) => check.slug === 'feedback:read');

      expect(german?.locale).toBe('de');
      expect(feedback?.reason).toMatchObject({ locale: 'en', usedFallback: true });
    });

    it('reports the host default as its locale when the request names none (#1301)', async () => {
      const presentation = await service.presentForUnit('plg_1', SERVER_UNIT);

      expect(presentation?.locale).toBe('en');
    });

    it('a regional variant falls back to its base language before the default', async () => {
      const presentation = await service.presentForUnit('plg_1', SERVER_UNIT, 'de-AT');

      expect(presentation?.displayName).toEqual({ value: 'Demo-Senke', locale: 'de', usedFallback: true });
    });

    it.each(['fr', 'not a locale !!'])(
      'unsupported or malformed locale %j resolves at the default, flagged',
      async (locale) => {
        const presentation = await service.presentForUnit('plg_1', SERVER_UNIT, locale);

        expect(presentation?.displayName).toEqual({ value: 'Demo Sink', locale: 'en', usedFallback: true });
      },
    );
  });

  describe('presentPendingForUnit (staged update approval surface)', () => {
    const pendingManifest = buildPluginManifest({ scope: 'household', version: '1.3.0' });
    pendingManifest.permissions.declares = ['manage:digest', 'read:digest'];
    pendingManifest.permissions.checks = [
      // Carried over from the active version — its server grant still answers.
      {
        slug: 'feedback:read',
        required: false,
        reason: { en: 'Reads feedback to compose the digest.' },
        feature: 'weekly-digest',
        consentScope: 'server',
      },
      // NEW declare in the pending version: no PluginPermission row exists yet.
      {
        slug: 'read:digest',
        required: false,
        reason: { en: 'Reads stored digests for insights.' },
        consentScope: 'server',
      },
    ];

    it('returns null when no update is staged', async () => {
      await expect(service.presentPendingForUnit('plg_1', SERVER_UNIT)).resolves.toBeNull();
    });

    it("presents the PENDING manifest against today's decisions", async () => {
      db.plugin.findUnique.mockResolvedValue(
        pluginRow({
          pendingVersion: '1.3.0',
          pendingManifestJson: pendingManifest,
          pendingSha256: STAGED_SHA,
        }) as never,
      );

      const presentation = await service.presentPendingForUnit('plg_1', SERVER_UNIT);

      expect(presentation).toMatchObject({ manifestVersion: '1.3.0', source: 'staged' });
      expect(presentation?.checks).toEqual([
        expect.objectContaining({ slug: 'feedback:read', decision: 'granted' }),
        // The new declare's catalog row arrives with activation; its risk is
        // the locked Low every plugin-declared row carries (#59), and
        // nothing has been decided about it.
        expect.objectContaining({
          slug: 'plugin|demo-sink|read:digest',
          origin: 'plugin',
          decision: 'pending',
          riskLevel: RiskLevel.Low,
          decidedRiskLevel: null,
        }),
      ]);
    });

    it('rejects a pending manifest that drifted from the pending columns', async () => {
      db.plugin.findUnique.mockResolvedValue(
        pluginRow({ pendingVersion: '2.0.0', pendingManifestJson: pendingManifest }) as never,
      );

      await expect(service.presentPendingForUnit('plg_1', SERVER_UNIT)).rejects.toThrow(
        PluginConsentPresentationManifestError,
      );
    });

    describe('presentPendingFromRow (snapshot-taking form)', () => {
      it('presents from the caller-supplied row without re-reading the plugin — the snapshot guarantee', async () => {
        const row = pluginRow({
          pendingVersion: '1.3.0',
          pendingManifestJson: pendingManifest,
          pendingSha256: STAGED_SHA,
        });

        const presentation = await service.presentPendingFromRow(row, SERVER_UNIT);

        expect(presentation).toMatchObject({ manifestVersion: '1.3.0', source: 'staged' });
        // No row re-read: a re-read could observe a replacement staging —
        // possibly under the same version — and the composed response would
        // mix two updates.
        expect(db.plugin.findUnique).not.toHaveBeenCalled();
      });

      it('keeps the loading form’s null contract: tombstoned or nothing staged has no pending surface', async () => {
        await expect(
          service.presentPendingFromRow(
            pluginRow({ pendingVersion: '1.3.0', pendingManifestJson: pendingManifest, uninstalledAt: new Date() }),
            SERVER_UNIT,
          ),
        ).resolves.toBeNull();
        await expect(service.presentPendingFromRow(pluginRow(), SERVER_UNIT)).resolves.toBeNull();
      });

      it('rejects a structurally invalid unit at the boundary, exactly as the loading form does', async () => {
        await expect(
          service.presentPendingFromRow(
            pluginRow({ pendingVersion: '1.3.0', pendingManifestJson: pendingManifest, pendingSha256: STAGED_SHA }),
            {
              scopeType: 'Household',
            } as unknown as PluginUnit,
          ),
        ).rejects.toThrow(RangeError);
      });
    });
  });

  describe('the consent surface a unit consents from (#1150)', () => {
    /**
     * Active and staged manifests for the staged-only comparison: one
     * requested permission tightens from optional to required, one moves from
     * server to household consent scope, and one is new in the staged version.
     */
    const activeManifest = buildPluginManifest({ scope: 'household' });
    activeManifest.permissions.checks = [
      {
        slug: 'feedback:read',
        required: false,
        reason: { en: 'Reads feedback to compose the digest.' },
        feature: 'weekly-digest',
        consentScope: 'server',
      },
      {
        slug: 'create:notification',
        required: false,
        reason: { en: 'Sends the digest as a notification.' },
        consentScope: 'server',
      },
    ];

    const stagedManifest = buildPluginManifest({ scope: 'household', version: '1.3.0' });
    stagedManifest.permissions.declares = ['read:digest'];
    stagedManifest.permissions.checks = [
      {
        slug: 'feedback:read',
        required: true,
        reason: { en: 'Reads feedback to compose the digest.' },
        feature: 'weekly-digest',
        consentScope: 'server',
      },
      {
        slug: 'create:notification',
        required: false,
        reason: { en: 'Sends the digest as a notification.' },
        consentScope: 'household',
      },
      {
        slug: 'read:digest',
        required: false,
        reason: { en: 'Reads stored digests for insights.' },
        consentScope: 'server',
      },
    ];

    const stagedRow = () =>
      pluginRow({
        manifestJson: activeManifest,
        pendingVersion: '1.3.0',
        pendingManifestJson: stagedManifest,
        pendingSha256: STAGED_SHA,
      });

    it('returns the artifact sha the consent surface was built from (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValue(stagedRow() as never);

      const active = await service.presentForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);
      const staged = await service.presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);

      expect(active.manifestSha256).toBe(INSTALLED_SHA);
      expect(staged.manifestSha256).toBe(STAGED_SHA);
      expect(staged).toMatchObject({ source: 'staged', manifestVersion: '1.3.0' });
    });

    it('names the staged update on the active surface, and nothing when none is staged (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValueOnce(stagedRow() as never);
      const withStaged = await service.presentForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);
      expect(withStaged.stagedUpdate).toEqual({ manifestVersion: '1.3.0', manifestSha256: STAGED_SHA });

      db.plugin.findUnique.mockResolvedValueOnce(stagedRow() as never);
      const staged = await service.presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);
      expect(staged.stagedUpdate).toBeNull();

      const withoutStaged = await service.presentForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);
      expect(withoutStaged.stagedUpdate).toBeNull();
    });

    it('marks a required permission that cannot be granted (#1150)', async () => {
      // `feedback:read` does not bind a household, so consent at household
      // scope could never confer it.
      const unboundManifest = buildPluginManifest({ scope: 'household' });
      unboundManifest.permissions.declares = [];
      unboundManifest.permissions.checks = [
        {
          slug: 'feedback:read',
          required: true,
          reason: { en: 'Reads feedback to compose the digest.' },
          consentScope: 'household',
        },
        {
          slug: 'create:notification',
          required: false,
          reason: { en: 'Sends the digest as a notification.' },
          consentScope: 'household',
        },
        {
          slug: 'read:public_content',
          required: false,
          reason: { en: 'Shows public excerpts in per-user views.' },
          consentScope: 'user',
        },
      ];
      db.plugin.findUnique.mockResolvedValue(pluginRow({ manifestJson: unboundManifest }) as never);

      const presentation = await service.presentForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);

      expect(presentation.checks).toEqual([
        expect.objectContaining({ slug: 'feedback:read', required: true, grantable: false, stagedOnly: false }),
        expect.objectContaining({ slug: 'create:notification', grantable: true, stagedOnly: false }),
        // Another unit axis decides it, so this surface cannot call it ungrantable.
        expect.objectContaining({ slug: 'read:public_content', decision: 'per-unit', grantable: true }),
      ]);
    });

    it('marks a staged permission the active manifest does not request at that scope as staged only (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValue(stagedRow() as never);

      const presentation = await service.presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);

      expect(presentation.checks).toEqual([
        // Optional before, required now: still requested at the same scope.
        expect.objectContaining({ slug: 'feedback:read', stagedOnly: false }),
        // Server scope before, household scope now: new to this household.
        expect.objectContaining({ slug: 'create:notification', consentScope: 'household', stagedOnly: true }),
        // New in the staged manifest; no catalog row until activation, still grantable.
        expect.objectContaining({ slug: 'plugin|demo-sink|read:digest', stagedOnly: true, grantable: true }),
      ]);
    });

    it('shows a pre-consent on a declared permission the staged update adds as granted, before activation creates its catalog row (#1150)', async () => {
      const preConsentManifest = buildPluginManifest({ scope: 'household', version: '1.3.0' });
      preConsentManifest.permissions.declares = ['read:digest'];
      preConsentManifest.permissions.checks = [
        {
          slug: 'read:digest',
          required: false,
          reason: { en: 'Reads stored digests for insights.' },
          consentScope: 'household',
        },
      ];
      db.plugin.findUnique.mockResolvedValue(
        pluginRow({
          manifestJson: activeManifest,
          pendingVersion: '1.3.0',
          pendingManifestJson: preConsentManifest,
          pendingSha256: STAGED_SHA,
        }) as never,
      );
      db.pluginGrant.findMany.mockResolvedValue([
        {
          permissionSlug: 'plugin|demo-sink|read:digest',
          scopeType: PluginGrantScope.Household,
          status: PluginGrantStatus.Granted,
          decidedRiskLevel: RiskLevel.Low,
        },
      ] as never);

      const presentation = await service.presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT);

      expect(presentation.checks).toEqual([
        expect.objectContaining({
          slug: 'plugin|demo-sink|read:digest',
          decision: 'granted',
          riskLevel: RiskLevel.Low,
          grantable: true,
        }),
      ]);
    });

    it('refuses a staged surface when nothing is staged (#1150)', async () => {
      const failure = await service
        .presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginConsentPresentationNoStagedUpdateError);
      expect(failure).toMatchObject({ pluginSlug: 'demo-sink' });
    });

    it('refuses a staged surface for an unknown or uninstalled plugin, tombstone before the manifest (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValueOnce(null as never);
      await expect(service.presentStagedForUnitBySlug('ghost', HOUSEHOLD_UNIT)).rejects.toThrow(
        PluginConsentPresentationNotFoundError,
      );

      db.plugin.findUnique.mockResolvedValueOnce(
        pluginRow({ uninstalledAt: new Date(), manifestJson: { corrupted: true } }) as never,
      );
      await expect(service.presentStagedForUnitBySlug('demo-sink', HOUSEHOLD_UNIT)).rejects.toThrow(
        PluginConsentPresentationTombstonedError,
      );
    });
  });
});
