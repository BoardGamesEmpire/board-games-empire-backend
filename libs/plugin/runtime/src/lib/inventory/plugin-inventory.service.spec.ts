import {
  DatabaseService,
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  Prisma,
  RiskLevel,
} from '@bge/database';
import {
  batchTransactionCall,
  createMockDatabaseService,
  UNIT_BOUND_RULES,
  type MockDatabaseService,
} from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { PluginConsentCheckClassifier } from '../consent/plugin-consent-check-classifier.service';
import { PluginConsentStandingService } from '../consent/plugin-consent-standing.service';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PluginInventoryManifestError,
  PluginInventoryNotFoundError,
  PluginInventoryTombstonedError,
} from './inventory.errors';
import {
  PluginInventoryService,
  type PluginInventoryCeiling,
  type PluginServerInventoryCeiling,
} from './plugin-inventory.service';

describe('PluginInventoryService', () => {
  const options = buildPluginModuleOptions();

  const manifest = buildPluginManifest();
  const INSTALLED_AT = new Date('2026-08-01T00:00:00Z');
  const MANAGE_CANONICAL = 'plugin|demo-sink|manage:digest';

  const grant = (
    slug: string,
    scopeType: PluginGrantScope,
    decidedRiskLevel: RiskLevel = RiskLevel.Low,
    status: PluginGrantStatus = PluginGrantStatus.Granted,
  ) => ({ permissionSlug: slug, scopeType, status, decidedRiskLevel });

  const serverGrants = [
    grant('feedback:read', PluginGrantScope.Server),
    grant(MANAGE_CANONICAL, PluginGrantScope.Server),
  ];

  /** The baseline manifest plus the unit-scope checks a household or user can owe. */
  const manifestWithUnitChecks = () => {
    const withChecks = buildPluginManifest({ scope: 'household' });
    withChecks.permissions.checks = [
      ...withChecks.permissions.checks,
      {
        slug: 'update:calendar',
        required: true,
        reason: { en: 'Writes digest reminders to the household calendar.' },
        consentScope: 'household',
      },
      {
        slug: 'read:public_content',
        required: true,
        reason: { en: 'Shows public content excerpts inside per-user views.' },
        consentScope: 'user',
      },
    ];

    return withChecks;
  };

  /** A row as `INVENTORY_SELECT` returns it — installed, living, no pending update. */
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    enabled: true,
    restartRequired: false,
    installedAt: INSTALLED_AT,
    uninstalledAt: null,
    installedFromUrl: 'https://registry.test/demo-sink-1.2.0.tgz',
    installedSha256: 'a'.repeat(64),
    registrySlug: 'community',
    pendingVersion: null,
    pendingSince: null,
    pendingSha256: null,
    pendingStagingId: null,
    manifestJson: manifest,
    ...overrides,
  });

  /**
   * Stands in for the caller's permission ceiling. Distinct from any scope a
   * list names, so each assertion can tell which half of a `where` came from
   * the caller.
   */
  const CEILING: Prisma.PluginWhereInput = { id: { in: ['within-the-ceiling'] } };

  let db: MockDatabaseService;
  let service: PluginInventoryService;
  let unitCeiling: jest.MockedFunction<PluginInventoryCeiling>;
  let serverCeiling: jest.MockedFunction<PluginServerInventoryCeiling>;

  beforeEach(() => {
    db = createMockDatabaseService();
    // The server-consented checks of the baseline manifest are granted, so a
    // unit enablement reads `on` unless a test makes it owe something (#1149).
    db.pluginGrant.findMany.mockResolvedValue(serverGrants as never);
    db.permission.findMany.mockResolvedValue([{ slug: 'feedback:read', riskLevel: RiskLevel.Low }] as never);
    db.pluginPermission.findMany.mockResolvedValue([{ slug: MANAGE_CANONICAL, riskLevel: RiskLevel.Low }] as never);

    // The real classifier over the mock database, so the standing assertions
    // exercise the consent rule itself rather than a stubbed answer.
    const standing = new PluginConsentStandingService(
      new PluginConsentCheckClassifier(db as unknown as DatabaseService),
      options,
    );
    service = new PluginInventoryService(
      db as unknown as DatabaseService,
      standing,
      new PluginConfigSchemaService(),
      options,
    );
    unitCeiling = jest.fn((scope: Prisma.PluginWhereInput) => ({ AND: [scope, CEILING] }));
    serverCeiling = jest.fn(() => CEILING);
  });

  afterEach(() => jest.clearAllMocks());

  describe('listForServer', () => {
    it('reads the rows and the count in ONE RepeatableRead transaction (D-CD)', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const result = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      const { operations, options: txOptions } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(txOptions?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
      expect(result.total).toBe(1);
    });

    it('derives skip/take from the resolved paging and orders by the unique slug', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 50, pageSize: 25 }, serverCeiling);

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25, orderBy: { slug: 'asc' } }),
      );
    });

    it('excludes tombstones by default, and the count sees the SAME predicate (D-CH)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      const where = { AND: [CEILING, { uninstalledAt: null }] };
      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('includes tombstones only when explicitly asked (D-CH)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling, { includeUninstalled: true });

      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [CEILING, {}] } }));
    });

    // The opt-in admits tombstones; it must not admit what the caller's
    // ceiling leaves out, so the filter goes beside the ceiling and never
    // replaces it.
    it("keeps the caller's ceiling on the rows and the count whatever the tombstone opt-in says", async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      for (const includeUninstalled of [true, false, undefined]) {
        await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling, { includeUninstalled });
      }

      expect(serverCeiling).toHaveBeenCalledTimes(3);
      for (const [args] of [...db.plugin.findMany.mock.calls, ...db.plugin.count.mock.calls]) {
        expect((args?.where as { AND: unknown[] }).AND[0]).toBe(CEILING);
      }
    });

    it('localizes displayName/description for the requested locale', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling, { locale: 'de' });

      expect(rows[0].displayName).toBe('Demo-Senke');
      expect(rows[0].manifestUnreadable).toBe(false);
    });

    it('falls back to the host default locale when none is supplied', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].displayName).toBe('Demo Sink');
    });

    it('reports where the artifact came from, in one shape (#696)', async () => {
      // Every plugin is installed from a plugin artifact, so provenance has no
      // kind to tell apart: it is the artifact's checksum, link and registry.
      db.plugin.findMany.mockResolvedValue([
        row({ installedFromUrl: 'https://registry.example/x.tgz', registrySlug: 'bge-official' }),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].provenance).toStrictEqual({
        sha256: 'a'.repeat(64),
        url: 'https://registry.example/x.tgz',
        registrySlug: 'bge-official',
      });
    });

    it('refuses a stored checksum that is not 64 lowercase hex characters (#1117)', async () => {
      // Only a hand edit of the database can leave one, since the install and
      // an update's activation write the resolver's branded value. The
      // resolver refuses it at boot.
      db.plugin.findMany.mockResolvedValue([row({ installedSha256: 'ABC' })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      await expect(service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling)).rejects.toBeInstanceOf(
        PluginDirectoryLayoutError,
      );
    });

    it('surfaces a staged update with pendingSince, never updatedAt, and its staging id (#357)', async () => {
      // The staging id is what reject must name. The staged-update read can't
      // present a staging whose manifest no longer validates (a BGE upgrade
      // past its range, say), so this read, which never parses the staged
      // manifest, is where a client finds the id to reject it with.
      const since = new Date('2026-08-20T10:00:00Z');
      db.plugin.findMany.mockResolvedValue([
        row({
          pendingVersion: '1.3.0',
          pendingSince: since,
          pendingSha256: 'b'.repeat(64),
          pendingStagingId: 'staging-a',
        }),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].pendingUpdate).toEqual({ version: '1.3.0', since, stagingId: 'staging-a' });
    });

    // #696: approval answers 409 no staged update for a staged row without a
    // checksum, so the list must not offer that row an update to approve.
    it('reports a staged row without a checksum as no staged update, as approval does', async () => {
      db.plugin.findMany.mockResolvedValue([
        row({
          pendingVersion: '1.3.0',
          pendingSince: new Date('2026-08-20T10:00:00Z'),
          pendingStagingId: 'staging-a',
          pendingSha256: null,
        }),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].pendingUpdate).toBeNull();
    });

    it('reports no staged update as null rather than an empty object', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].pendingUpdate).toBeNull();
    });

    describe('a corrupt stored manifest degrades its own row (D-CG)', () => {
      it('keeps the identity columns and marks the row', async () => {
        db.plugin.findMany.mockResolvedValue([row({ manifestJson: { nonsense: true } })] as never);
        db.plugin.count.mockResolvedValue(1 as never);

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

        expect(rows[0]).toEqual(
          expect.objectContaining({
            slug: 'demo-sink',
            version: '1.2.0',
            enabled: true,
            displayName: null,
            description: null,
            manifestUnreadable: true,
          }),
        );
      });

      it('does not take out the good rows sharing the page', async () => {
        db.plugin.findMany.mockResolvedValue([
          row({ id: 'plugin-2', slug: 'broken-sink', manifestJson: { nonsense: true } }),
          row(),
        ] as never);
        db.plugin.count.mockResolvedValue(2 as never);

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

        expect(rows.map((entry) => entry.manifestUnreadable)).toEqual([true, false]);
        expect(rows[1].displayName).toBe('Demo Sink');
      });

      // The row/manifest slug disagreement specifically, not a parse failure:
      // this manifest is fully valid on its own and would serve — it just
      // describes a DIFFERENT plugin, so its canonical permission slugs would
      // resolve against another catalog. Degrading is the honest answer.
      it('degrades a manifest that is valid but describes another plugin', async () => {
        db.plugin.findMany.mockResolvedValue([row({ slug: 'other-sink' })] as never);
        db.plugin.count.mockResolvedValue(1 as never);

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

        expect(rows[0]).toEqual(
          expect.objectContaining({ slug: 'other-sink', displayName: null, manifestUnreadable: true }),
        );
      });
    });
  });

  describe('listRunningOnServer (#78)', () => {
    /** The fixture plugin manifest's display name in one locale, read rather than restated. */
    const nameIn = (locale: string) => (manifest.displayName as Record<string, string>)[locale];

    it('reads only enabled, installed, loaded server-scope plugins, by slug, with no ceiling', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);

      await service.listRunningOnServer();

      expect(db.plugin.findMany).toHaveBeenCalledWith({
        where: { scope: PluginScope.Server, enabled: true, uninstalledAt: null, loadFailed: false },
        select: expect.objectContaining({ slug: true, category: true, version: true, manifestJson: true }),
        orderBy: { slug: 'asc' },
      });
      // One statement, so there is no total to keep consistent with it.
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('returns slug, plugin category and the display name in the requested locale', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);

      await expect(service.listRunningOnServer('de')).resolves.toEqual([
        { slug: 'demo-sink', category: PluginCategory.FeedbackSink, displayName: nameIn('de') },
      ]);
    });

    it('falls back to the default-locale name for a locale the plugin manifest lacks', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);

      const [plugin] = await service.listRunningOnServer('xx');

      expect(plugin.displayName).toBe(nameIn(options.defaultLocale));
    });

    it('leaves out a plugin whose stored plugin manifest no longer validates, and still returns the rest', async () => {
      db.plugin.findMany.mockResolvedValue([
        row({ id: 'plugin-2', slug: 'broken', manifestJson: { nonsense: true } }),
        row(),
      ] as never);

      await expect(service.listRunningOnServer()).resolves.toEqual([expect.objectContaining({ slug: 'demo-sink' })]);
    });
  });

  describe('getBySlug', () => {
    it('throws NotFound for an unknown slug', async () => {
      db.plugin.findUnique.mockResolvedValue(null as never);

      await expect(service.getBySlug('nope')).rejects.toBeInstanceOf(PluginInventoryNotFoundError);
    });

    it('throws Tombstoned for an uninstalled plugin, with no opt-out (D-CH)', async () => {
      const uninstalledAt = new Date('2026-08-22T00:00:00Z');
      db.plugin.findUnique.mockResolvedValue(row({ uninstalledAt }) as never);

      await expect(service.getBySlug('demo-sink')).rejects.toMatchObject({
        name: 'PluginInventoryTombstonedError',
        uninstalledAt,
      });
    });

    it('a tombstoned plugin whose manifest ALSO went stale is still a 410, never a 500', async () => {
      db.plugin.findUnique.mockResolvedValue(
        row({ uninstalledAt: new Date('2026-08-22T00:00:00Z'), manifestJson: { nonsense: true } }) as never,
      );

      await expect(service.getBySlug('demo-sink')).rejects.toBeInstanceOf(PluginInventoryTombstonedError);
    });

    it('THROWS on a corrupt manifest — the list degrades, the single read does not (D-CG)', async () => {
      db.plugin.findUnique.mockResolvedValue(row({ manifestJson: { nonsense: true } }) as never);

      await expect(service.getBySlug('demo-sink')).rejects.toBeInstanceOf(PluginInventoryManifestError);
    });

    it('adds the manifest detail a list page has no room for', async () => {
      db.plugin.findUnique.mockResolvedValue(row({ executionMode: PluginExecutionMode.InProcess }) as never);

      const detail = await service.getBySlug('demo-sink', 'de');

      expect(detail.executionMode).toBe(PluginExecutionMode.InProcess);
      expect(detail.displayName).toBe('Demo-Senke');
      expect(detail.features).toEqual([
        {
          name: 'weekly-digest',
          displayName: 'Weekly digest',
          description: 'Sends a weekly summary of collected feedback.',
        },
      ]);
      expect(detail.manifestUnreadable).toBe(false);
    });
  });

  describe('existsUnderCeiling (#789)', () => {
    it('reads the slug under the ceiling it is handed', async () => {
      db.plugin.findFirst.mockResolvedValue({ id: 'plugin-1' } as never);

      await service.existsUnderCeiling('demo-sink', unitCeiling);

      expect(unitCeiling).toHaveBeenCalledWith({ slug: 'demo-sink' });
      expect(db.plugin.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ slug: 'demo-sink' }, { AND: [{ slug: 'demo-sink' }, CEILING] }] },
        select: { id: true },
      });
    });

    // As the lists do, the lookup runs its own scope beside what the ceiling
    // returns, so a ceiling that drops the slug cannot answer for another
    // plugin.
    it('keeps the slug when the ceiling drops it', async () => {
      db.plugin.findFirst.mockResolvedValue(null as never);

      await service.existsUnderCeiling('demo-sink', () => CEILING);

      expect(db.plugin.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ slug: 'demo-sink' }, CEILING] },
        select: { id: true },
      });
    });

    it('is true when a row comes back', async () => {
      db.plugin.findFirst.mockResolvedValue({ id: 'plugin-1' } as never);

      await expect(service.existsUnderCeiling('demo-sink', unitCeiling)).resolves.toBe(true);
    });

    it('is false when none does', async () => {
      db.plugin.findFirst.mockResolvedValue(null as never);

      await expect(service.existsUnderCeiling('demo-sink', unitCeiling)).resolves.toBe(false);
    });
  });

  describe('listForHousehold', () => {
    /**
     * A household-scope plugin row by default: dormancy is worked out from the
     * manifest's own scope (#1151), so a household row needs a manifest with a
     * household surface unless a test arranges otherwise.
     */
    const householdRow = (overrides: Record<string, unknown> = {}, unit: unknown[] = []) => ({
      ...row({ scope: PluginScope.Household, manifestJson: buildPluginManifest({ scope: 'household' }), ...overrides }),
      householdPlugins: unit,
    });

    /** A household-scope manifest whose schema requires `webhookUrl`, so `{}` does not conform. */
    const requiringManifest = () => {
      const requiring = buildPluginManifest({ scope: 'household' });
      requiring.config = { ...requiring.config, schema: { ...requiring.config.schema, required: ['webhookUrl'] } };

      return requiring;
    };

    it('is driven from the plugin table, admitting the household axis OR an existing row (D-CE, D-CF)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(unitCeiling).toHaveBeenCalledWith({
        uninstalledAt: null,
        OR: [{ scope: PluginScope.Household }, { householdPlugins: { some: { householdId: 'hh-1' } } }],
      });
    });

    it('runs its scope beside the where the ceiling returns, for the rows and the count', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      const where = { AND: [unitCeiling.mock.calls[0]?.[0], unitCeiling.mock.results[0]?.value] };
      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    // The edge is handed the scope only to compose it. The list keeps its own
    // copy beside what comes back, so an edge that dropped it could not widen
    // the list past it.
    it('keeps its scope whatever the ceiling returns', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);
      unitCeiling.mockReturnValue({});

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      const where = {
        AND: [
          {
            uninstalledAt: null,
            OR: [{ scope: PluginScope.Household }, { householdPlugins: { some: { householdId: 'hh-1' } } }],
          },
          {},
        ],
      };
      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('joins only the unit enablement of THIS household', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            householdPlugins: { where: { householdId: 'hh-1' }, select: expect.anything() },
          }),
        }),
      );
    });

    it('an unanchored plugin reads as not-anchored, distinct from disabled (D-CE)', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({ scope: PluginScope.Household })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toEqual({
        anchored: false,
        enabled: false,
        state: 'off',
        dormancy: null,
        consent: { outstanding: [], optionalOff: [] },
      });
    });

    it('a row with a unit enablement carries its enablement, state code, dormancy and consent standing (#1149, #1151)', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({}, [{ enabled: true, config: {} }])] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toEqual({
        anchored: true,
        enabled: true,
        state: 'on',
        dormancy: null,
        consent: { outstanding: [], optionalOff: [] },
      });
    });

    it('selects only enabled and the document from the household unit enablement, and no stored consent or dormancy state (#1149, #1151)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            householdPlugins: { where: { householdId: 'hh-1' }, select: { enabled: true, config: true } },
          }),
        }),
      );
    });

    it("never serves the household's document: the unit carries exactly its five fields (#1151)", async () => {
      // `config` is selected only so the rule can judge it; a household's
      // settings belong to the config routes, not to the list.
      db.plugin.findMany.mockResolvedValue([
        householdRow({}, [{ enabled: true, config: { webhookUrl: 'https://hooks.example/secret' } }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(Object.keys(rows[0].unit).sort()).toEqual(['anchored', 'consent', 'dormancy', 'enabled', 'state']);
      expect(JSON.stringify(rows[0])).not.toContain('hooks.example');
    });

    it('a household row owing re-consent reads state review_pending (#1149)', async () => {
      // The household granted update:calendar when it was Low; the catalog has
      // since raised it, so the grant no longer covers (#1149).
      db.pluginGrant.findMany.mockResolvedValue([
        ...serverGrants,
        grant('update:calendar', PluginGrantScope.Household, RiskLevel.Low),
      ] as never);
      db.permission.findMany.mockResolvedValue([
        { slug: 'feedback:read', riskLevel: RiskLevel.Low },
        { slug: 'update:calendar', riskLevel: RiskLevel.High, ...UNIT_BOUND_RULES.Household },
      ] as never);
      db.plugin.findMany.mockResolvedValue([
        householdRow({ manifestJson: manifestWithUnitChecks() }, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit.state).toBe('review_pending');
      expect(rows[0].unit.consent.outstanding).toEqual([
        expect.objectContaining({
          slug: 'update:calendar',
          kind: 'risk_raised',
          required: true,
          riskLevel: RiskLevel.High,
        }),
      ]);
    });

    it('a row whose manifest cannot be read keeps its marker, reads unavailable with dormancy unavailable and reports an empty standing (#1149, #1151)', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ manifestJson: { nonsense: true } }, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].manifestUnreadable).toBe(true);
      // `on` would tell a client announcing the code alone that the unit runs,
      // while the ability path refuses an unreadable manifest (PR #1155 review).
      expect(rows[0].unit).toEqual({
        anchored: true,
        enabled: true,
        state: 'unavailable',
        dormancy: 'unavailable',
        consent: { outstanding: [], optionalOff: [] },
      });
      expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
    });

    it('localizes the outstanding reasons with the locale the list localizes with (#1149)', async () => {
      const withChecks = manifestWithUnitChecks();
      withChecks.permissions.checks[2] = {
        ...withChecks.permissions.checks[2],
        reason: {
          en: 'Writes digest reminders to the household calendar.',
          de: 'Schreibt Erinnerungen in den Haushaltskalender.',
        },
      };
      db.plugin.findMany.mockResolvedValue([
        householdRow({ manifestJson: withChecks }, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling, {
        locale: 'de',
      });

      expect(rows[0].unit.consent.outstanding[0]?.reason).toBe('Schreibt Erinnerungen in den Haushaltskalender.');
    });

    it('a switched-on unit enablement under a server-scope manifest reads unavailable for state and dormancy (#1151)', async () => {
      // A narrowing activation rewrites the plugin's scope and retires no unit
      // enablement, so the household still holds one the manifest has no
      // surface for.
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Server, manifestJson: manifest }, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toMatchObject({ state: 'unavailable', dormancy: 'unavailable' });
      expect(rows[0]).not.toHaveProperty('dormantReason');
      expect(rows[0].unit).not.toHaveProperty('dormantReason');
      // Dormancy is not a disable: the admin's own switch is untouched, which
      // is what makes a re-scope back restore their choice.
      expect(rows[0].unit.enabled).toBe(true);
    });

    it('a switched-on household row under a plugin a server admin switched off reads unavailable, with serverEnabled false (#1149)', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ enabled: false }, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      // Nothing runs while the server switch is off, so the code never says
      // on; the household's own switch is untouched and still reads true.
      // The server switch is not dormancy: serverEnabled already says it.
      expect(rows[0]).toMatchObject({
        serverEnabled: false,
        unit: { enabled: true, state: 'unavailable', dormancy: null },
      });
    });

    it('a switched-on row whose document the schema rejects reads needs_configuration for state and dormancy (#1151)', async () => {
      // The schema types webhookUrl as a string.
      db.plugin.findMany.mockResolvedValue([
        householdRow({}, [{ enabled: true, config: { webhookUrl: 42 } }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toMatchObject({ state: 'needs_configuration', dormancy: 'needs_configuration' });
    });

    it('a stored JSON null is a document the schema rejects, not an empty one (#1151)', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({}, [{ enabled: true, config: null }])] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toMatchObject({ state: 'needs_configuration', dormancy: 'needs_configuration' });
    });

    it('reports off with dormancy needs_configuration for a household that never switched on, when {} fails the schema (#1151)', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({ manifestJson: requiringManifest() })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      // A household with no unit enablement holds the empty document, so a
      // client can say before the switch-on that settings will be needed.
      expect(rows[0].unit).toMatchObject({ anchored: false, state: 'off', dormancy: 'needs_configuration' });
    });

    it('a config schema the server cannot use makes its own row unavailable and leaves the page to resolve (#1151)', async () => {
      // A readable manifest of its own: the slug namespaces its events, tables
      // and queues, so those follow it.
      const unusable = buildPluginManifest({
        scope: 'household',
        slug: 'broken-schema',
        events: { emits: ['plugin.broken-schema.digest-sent'] },
        storage: { ownTables: ['plugin_broken_schema_digests'] },
        jobs: { queues: ['plugin:broken-schema:digest'] },
        config: { schema: { type: 'no-such-type' } },
      });
      db.plugin.findMany.mockResolvedValue([
        householdRow({ id: 'plugin-2', slug: 'broken-schema', manifestJson: unusable }, [
          { enabled: true, config: {} },
        ]),
        householdRow({}, [{ enabled: true, config: {} }]),
      ] as never);
      db.plugin.count.mockResolvedValue(2 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows.map((entry) => [entry.slug, entry.unit.state, entry.unit.dormancy])).toEqual([
        ['broken-schema', 'unavailable', 'unavailable'],
        ['demo-sink', 'on', null],
      ]);
      expect(rows[0].manifestUnreadable).toBe(false);
    });

    it('a server-scope plugin with NO household row reads off, and dormancy unavailable says a switch-on could not run (#1151)', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Server, manifestJson: manifest }),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toMatchObject({ anchored: false, state: 'off', dormancy: 'unavailable' });
    });
  });

  describe('listForUser', () => {
    const userRow = (overrides: Record<string, unknown> = {}, unit: unknown[] = []) => ({
      ...row(overrides),
      userPlugins: unit,
    });

    it('narrows by NO plugin scope — user consent is legal at any scope (#225, D-CE)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(unitCeiling).toHaveBeenCalledWith({ uninstalledAt: null });
    });

    it('runs the where the ceiling returns, for the rows and the count', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      const where = { AND: [{ uninstalledAt: null }, { AND: [{ uninstalledAt: null }, CEILING] }] };
      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('keeps its scope whatever the ceiling returns', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);
      unitCeiling.mockReturnValue({});

      await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      const where = { AND: [{ uninstalledAt: null }, {}] };
      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('a user who has consented to nothing still sees the plugins, unanchored (D-CE)', async () => {
      db.plugin.findMany.mockResolvedValue([userRow()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows).toHaveLength(1);
      expect(rows[0].unit.anchored).toBe(false);
      expect(rows[0].displayName).toBe('Demo Sink');
    });

    it('a plugin the user never consented to reads anchored false, state off, and lists its user-scope checks under consent (#1149)', async () => {
      db.permission.findMany.mockResolvedValue([
        { slug: 'feedback:read', riskLevel: RiskLevel.Low },
        { slug: 'read:public_content', riskLevel: RiskLevel.Low, ...UNIT_BOUND_RULES.User },
      ] as never);
      db.plugin.findMany.mockResolvedValue([userRow({ manifestJson: manifestWithUnitChecks() })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit.anchored).toBe(false);
      expect(rows[0].unit.state).toBe('off');
      expect(rows[0].unit.consent.outstanding).toEqual([
        expect.objectContaining({ slug: 'read:public_content', kind: 'never_asked', required: true }),
      ]);
    });

    it('selects only enabled from the user row and carries no dormancy (#1149)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            userPlugins: { where: { userId: 'user-1' }, select: { enabled: true } },
          }),
        }),
      );
    });

    it('an anchored user row carries its own enablement state (#1149)', async () => {
      db.plugin.findMany.mockResolvedValue([userRow({}, [{ enabled: false }])] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toEqual({
        anchored: true,
        enabled: false,
        state: 'off',
        dormancy: null,
        consent: { outstanding: [], optionalOff: [] },
      });
    });

    it('a switched-on user row under a server-scope manifest reads dormancy null and runs (#225, #1151)', async () => {
      // The baseline manifest is server-scope: user consent is legal at any
      // plugin scope, and per-user configuration is never judged here.
      db.plugin.findMany.mockResolvedValue([userRow({}, [{ enabled: true }])] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toMatchObject({ state: 'on', dormancy: null });
    });

    it('a user row whose manifest cannot be read reads dormancy unavailable and keeps its marker (#1151)', async () => {
      db.plugin.findMany.mockResolvedValue([
        userRow({ manifestJson: { nonsense: true } }, [{ enabled: true }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].manifestUnreadable).toBe(true);
      expect(rows[0].unit).toMatchObject({ state: 'unavailable', dormancy: 'unavailable' });
    });
  });

  // The unit lists are gated on household membership / being a session user,
  // NOT on read:plugin. Anything an admin manages the install BY must stay off
  // them: where the tarball came from, its checksum, when it landed, whether a
  // restart is owed, and what update is staged.
  describe('privilege boundary between the server and unit reads', () => {
    // `version` is on this list because an exact version for every installed
    // plugin is the one field on an ungated read that materially helps someone
    // target a known vulnerability, and a unit screen has no use for it.
    // `uninstalledAt` because the unit reads never serve tombstones at all.
    const SERVER_ONLY = [
      'provenance',
      'installedAt',
      'restartRequired',
      'pendingUpdate',
      'enabled',
      'version',
      'uninstalledAt',
    ] as const;

    it('the household read neither selects nor serves the operational columns', async () => {
      db.plugin.findMany.mockResolvedValue([
        { ...row({ scope: PluginScope.Household }), householdPlugins: [] },
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      for (const field of SERVER_ONLY) {
        expect(rows[0]).not.toHaveProperty(field);
      }
      // The server switch is still reported, under a name that cannot be
      // confused with the unit's own.
      expect(rows[0].serverEnabled).toBe(true);

      const select = db.plugin.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
      for (const column of [
        'installedFromUrl',
        'installedSha256',
        'registrySlug',
        'pendingVersion',
        'pendingSince',
        'pendingSha256',
        'installedAt',
        'restartRequired',
        'uninstalledAt',
      ]) {
        expect(select).not.toHaveProperty(column);
      }
      // `version` IS selected — the manifest re-validation cross-checks it —
      // but it must not reach the response, which the field loop above proves.
      expect(select).toHaveProperty('version');
    });

    it('the user read neither selects nor serves them either', async () => {
      db.plugin.findMany.mockResolvedValue([{ ...row(), userPlugins: [] }] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      for (const field of SERVER_ONLY) {
        expect(rows[0]).not.toHaveProperty(field);
      }
      expect(rows[0].serverEnabled).toBe(true);

      const select = db.plugin.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
      expect(select).not.toHaveProperty('installedSha256');
    });

    it.each([
      ['household', () => service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling)],
      ['user', () => service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling)],
    ] as const)('the %s read filters tombstones unconditionally — there is no flag to pass', async (_axis, read) => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await read();

      // Inside the scope the list names, which it keeps beside the ceiling, so
      // no ceiling can drop it.
      expect(unitCeiling.mock.calls[0]?.[0]).toMatchObject({ uninstalledAt: null });
      const where = db.plugin.findMany.mock.calls[0]?.[0]?.where;
      expect(where?.AND).toEqual(expect.arrayContaining([expect.objectContaining({ uninstalledAt: null })]));
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('the server read still carries them — the split narrows the unit reads, not this one', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      for (const field of SERVER_ONLY) {
        expect(rows[0]).toHaveProperty(field);
      }
    });
  });
});
