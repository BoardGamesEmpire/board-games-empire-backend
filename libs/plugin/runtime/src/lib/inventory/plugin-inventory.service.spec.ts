import { DatabaseService, PluginCategory, PluginExecutionMode, PluginScope, Prisma } from '@bge/database';
import { batchTransactionCall, createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
import {
  PluginInventoryManifestError,
  PluginInventoryNotFoundError,
  PluginInventoryTombstonedError,
} from './inventory.errors';
import { PluginInventoryService } from './plugin-inventory.service';

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

  let db: MockDatabaseService;
  let service: PluginInventoryService;

  beforeEach(() => {
    db = createMockDatabaseService();
    service = new PluginInventoryService(db as unknown as DatabaseService, options);
  });

  afterEach(() => jest.clearAllMocks());

  describe('listForServer', () => {
    it('reads the rows and the count in ONE RepeatableRead transaction (D-CD)', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const result = await service.listForServer({ skip: 0, pageSize: 25 });

      const { operations, options: txOptions } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(txOptions?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
      expect(result.total).toBe(1);
    });

    it('derives skip/take from the resolved paging and orders by the unique slug', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 50, pageSize: 25 });

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25, orderBy: { slug: 'asc' } }),
      );
    });

    it('excludes tombstones by default, and the count sees the SAME predicate (D-CH)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 0, pageSize: 25 });

      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { uninstalledAt: null } }));
      expect(db.plugin.count).toHaveBeenCalledWith({ where: { uninstalledAt: null } });
    });

    it('includes tombstones only when explicitly asked (D-CH)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForServer({ skip: 0, pageSize: 25 }, { includeUninstalled: true });

      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('localizes displayName/description for the requested locale', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 }, { locale: 'de' });

      expect(rows[0].displayName).toBe('Demo-Senke');
      expect(rows[0].manifestUnreadable).toBe(false);
    });

    it('falls back to the host default locale when none is supplied', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

      expect(rows[0].displayName).toBe('Demo Sink');
    });

    it('renders installed provenance from the artifact columns', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

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

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

      expect(rows[0].provenance).toEqual({ kind: 'bundled' });
    });

    it('surfaces a staged update with pendingSince, never updatedAt', async () => {
      const since = new Date('2026-08-20T10:00:00Z');
      db.plugin.findMany.mockResolvedValue([row({ pendingVersion: '1.3.0', pendingSince: since })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

      expect(rows[0].pendingUpdate).toEqual({ version: '1.3.0', since });
    });

    it('reports no staged update as null rather than an empty object', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

      expect(rows[0].pendingUpdate).toBeNull();
    });

    describe('a corrupt stored manifest degrades its own row (D-CG)', () => {
      it('keeps the identity columns and marks the row', async () => {
        db.plugin.findMany.mockResolvedValue([row({ manifestJson: { nonsense: true } })] as never);
        db.plugin.count.mockResolvedValue(1 as never);

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

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

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

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

        const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

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

  describe('listForHousehold', () => {
    const householdRow = (overrides: Record<string, unknown> = {}, unit: unknown[] = []) => ({
      ...row(overrides),
      householdPlugins: unit,
    });

    it('is driven from the plugin table, admitting the household axis OR an existing row (D-CE, D-CF)', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

      expect(db.plugin.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            uninstalledAt: null,
            OR: [{ scope: PluginScope.Household }, { householdPlugins: { some: { householdId: 'hh-1' } } }],
          },
        }),
      );
    });

    it('joins only THIS household enablement row', async () => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

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

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

      expect(rows[0].unit).toEqual({
        anchored: false,
        enabled: false,
        suspendedForConsent: false,
        suspendedAt: null,
      });
      expect(rows[0].scopeOrphaned).toBe(false);
    });

    it('an anchored row carries its enablement and suspension state', async () => {
      const suspendedAt = new Date('2026-08-21T00:00:00Z');
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Household }, [{ enabled: true, suspendedForConsent: true, suspendedAt }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

      expect(rows[0].unit).toEqual({ anchored: true, enabled: true, suspendedForConsent: true, suspendedAt });
    });

    it('flags a row the plugin scope no longer admits — the #369 orphan (D-CF)', async () => {
      db.plugin.findMany.mockResolvedValue([
        householdRow({ scope: PluginScope.Server }, [{ enabled: true, suspendedForConsent: false, suspendedAt: null }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

      expect(rows[0].scopeOrphaned).toBe(true);
      expect(rows[0].unit.enabled).toBe(true);
    });

    it('a server-scope plugin with NO household row is not an orphan — it was never enabled here', async () => {
      db.plugin.findMany.mockResolvedValue([householdRow({ scope: PluginScope.Server })] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

      expect(rows[0].scopeOrphaned).toBe(false);
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

      await service.listForUser('user-1', { skip: 0, pageSize: 25 });

      expect(db.plugin.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { uninstalledAt: null } }));
    });

    it('a user who has consented to nothing still sees the plugins, unanchored (D-CE)', async () => {
      db.plugin.findMany.mockResolvedValue([userRow()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 });

      expect(rows).toHaveLength(1);
      expect(rows[0].unit.anchored).toBe(false);
      expect(rows[0].displayName).toBe('Demo Sink');
    });

    it('an anchored user row carries its own enablement state', async () => {
      db.plugin.findMany.mockResolvedValue([
        userRow({}, [{ enabled: false, suspendedForConsent: false, suspendedAt: null }]),
      ] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 });

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

      const { rows } = await service.listForHousehold('hh-1', { skip: 0, pageSize: 25 });

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

      const { rows } = await service.listForUser('user-1', { skip: 0, pageSize: 25 });

      for (const field of SERVER_ONLY) {
        expect(rows[0]).not.toHaveProperty(field);
      }
      expect(rows[0].serverEnabled).toBe(true);

      const select = db.plugin.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
      expect(select).not.toHaveProperty('installedSha256');
    });

    it.each([
      ['household', () => service.listForHousehold('hh-1', { skip: 0, pageSize: 25 })],
      ['user', () => service.listForUser('user-1', { skip: 0, pageSize: 25 })],
    ] as const)('the %s read filters tombstones unconditionally — there is no flag to pass', async (_axis, read) => {
      db.plugin.findMany.mockResolvedValue([] as never);
      db.plugin.count.mockResolvedValue(0 as never);

      await read();

      const where = db.plugin.findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
      expect(where['uninstalledAt']).toBeNull();
      expect(db.plugin.count).toHaveBeenCalledWith({ where });
    });

    it('the server read still carries them — the split narrows the unit reads, not this one', async () => {
      db.plugin.findMany.mockResolvedValue([row()] as never);
      db.plugin.count.mockResolvedValue(1 as never);

      const { rows } = await service.listForServer({ skip: 0, pageSize: 25 });

      for (const field of SERVER_ONLY) {
        expect(rows[0]).toHaveProperty(field);
      }
    });
  });
});
