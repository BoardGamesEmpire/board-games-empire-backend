import {
  DatabaseService,
  PluginCategory,
  PluginExecutionMode,
  PluginScope,
  PluginUnitDormantReason,
  Prisma,
} from '@bge/database';
import { batchTransactionCall, createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
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
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  const manifest = buildPluginManifest();
  const INSTALLED_AT = new Date('2026-08-01T00:00:00Z');

  /** A row as `INVENTORY_SELECT` returns it — installed, living, no pending update. */
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    enabled: true,
    bundled: false,
    restartRequired: false,
    installedAt: INSTALLED_AT,
    uninstalledAt: null,
    installedFromUrl: 'https://registry.test/demo-sink-1.2.0.tgz',
    installedSha256: 'a'.repeat(64),
    registrySlug: 'community',
    pendingVersion: null,
    pendingSince: null,
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
    service = new PluginInventoryService(db as unknown as DatabaseService, options);
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

    it('renders installed provenance from the artifact columns', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].provenance).toEqual({
        kind: 'installed',
        sha256: 'a'.repeat(64),
        url: 'https://registry.test/demo-sink-1.2.0.tgz',
        registrySlug: 'community',
      });
    });

    it('a bundled plugin carries no artifact fields at all', async () => {
      db.plugin.findMany.mockResolvedValue([
        row({ bundled: true, installedSha256: null, installedFromUrl: null, registrySlug: null }),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].provenance).toEqual({ kind: 'bundled' });
    });

    it('surfaces a staged update with pendingSince, never updatedAt', async () => {
      const since = new Date('2026-08-20T10:00:00Z');
      db.plugin.findMany.mockResolvedValue([row({ pendingVersion: '1.3.0', pendingSince: since })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, serverCeiling);

      expect(rows[0].pendingUpdate).toEqual({ version: '1.3.0', since });
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
    const householdRow = (overrides: Record<string, unknown> = {}, unit: unknown[] = []) => ({
      ...row(overrides),
      householdPlugins: unit,
    });

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

    it('joins only THIS household enablement row', async () => {
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
        suspendedForConsent: false,
        suspendedAt: null,
      });
      expect(rows[0].dormantReason).toBeNull();
    });

    it('an anchored row carries its enablement and suspension state', async () => {
      const suspendedAt = new Date('2026-08-21T00:00:00Z');
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Household }, [{ enabled: true, suspendedForConsent: true, suspendedAt }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toEqual({ anchored: true, enabled: true, suspendedForConsent: true, suspendedAt });
    });

    it('reports the dormancy the row carries — the #369 orphan, as activation wrote it (D-CM)', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Server }, [
          {
            enabled: true,
            suspendedForConsent: false,
            suspendedAt: null,
            dormantReason: PluginUnitDormantReason.ScopeOrphaned,
          },
        ]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].dormantReason).toBe(PluginUnitDormantReason.ScopeOrphaned);
      // Dormancy is not a disable: the admin's own switch is untouched, which
      // is what makes a re-scope back restore their choice.
      expect(rows[0].unit.enabled).toBe(true);
    });

    it('reports a config dormancy under a household-scope plugin — the reason is read, not inferred from scope', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Household }, [
          {
            enabled: true,
            suspendedForConsent: false,
            suspendedAt: null,
            dormantReason: PluginUnitDormantReason.NeedsConfiguration,
          },
        ]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      // The replaced boolean could not have said this: the scope admits
      // households, so `scope === Server && anchored` was false here.
      expect(rows[0].dormantReason).toBe(PluginUnitDormantReason.NeedsConfiguration);
    });

    it('a server-scope plugin with NO household row is not dormant — there is no row to be dormant', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({ scope: PluginScope.Server })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].dormantReason).toBeNull();
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

    it('an anchored user row carries its own enablement state', async () => {
      db.plugin.findMany.mockResolvedValue([
        userRow({}, [{ enabled: false, suspendedForConsent: false, suspendedAt: null }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 }, unitCeiling);

      expect(rows[0].unit).toEqual({
        anchored: true,
        enabled: false,
        suspendedForConsent: false,
        suspendedAt: null,
      });
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
