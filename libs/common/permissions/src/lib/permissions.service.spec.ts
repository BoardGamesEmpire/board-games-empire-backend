import type { PluginUnit } from '@bge/actor-context';
import {
  Action,
  PluginGrantScope,
  PluginGrantStatus,
  ResourceType,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  User,
} from '@bge/database';
import { createTestingModuleWithDb, makePermission, type MockDatabaseService } from '@bge/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import { createCache, type Cache } from 'cache-manager';
import type { ApikeyWithScopes, UserPermissionWithPermission, UserWithRoles } from './interfaces';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let db: MockDatabaseService;
  let cache: Cache;

  beforeEach(async () => {
    // A real in-memory cache, not a stub: whether a cached graph still counts
    // as a hit depends on what an eviction wrote since it was cached.
    cache = createCache();

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [PermissionsService],
      overrideProviders: [{ provide: CACHE_MANAGER, useValue: cache }],
    });

    service = module.get(PermissionsService);
    db = mockDb;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('getApiKeyScopeGraph', () => {
    it('returns the cached graph without hitting the database on a cache hit', async () => {
      const apiKey = makeApiKeyGraph();
      db.apikey.findUnique.mockResolvedValue(apiKey);
      await service.getApiKeyScopeGraph('key-1');

      const result = await service.getApiKeyScopeGraph('key-1');

      expect(result).toBe(apiKey);
      expect(db.apikey.findUnique).toHaveBeenCalledTimes(1);
    });

    it('loads the key with scopes + permission triple and caches it on a miss', async () => {
      const set = jest.spyOn(cache, 'set');
      const apiKey = makeApiKeyGraph();
      db.apikey.findUnique.mockResolvedValue(apiKey);

      const result = await service.getApiKeyScopeGraph('key-1');

      expect(db.apikey.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          include: expect.objectContaining({
            scopes: expect.objectContaining({
              // A scope over a retired catalog row confers nothing (#235).
              where: { permission: { retiredAt: null } },
              include: { permission: { select: { action: true, subject: true, inverted: true, fields: true } } },
            }),
          }),
        }),
      );
      expect(set).toHaveBeenCalledWith('bge:apikey:scopes:key-1', expect.anything(), expect.any(Number));
      expect(result).toBe(apiKey);
    });

    it('returns null and does not cache when the key is missing (revoked)', async () => {
      db.apikey.findUnique.mockResolvedValue(null);

      const result = await service.getApiKeyScopeGraph('gone');

      expect(result).toBeNull();
      expect(await cache.get('bge:apikey:scopes:gone')).toBeUndefined();
    });
  });

  describe('loadUserRoleGraphWithin', () => {
    it("reads on the caller's transaction, past a cached graph, and caches nothing (#747)", async () => {
      // Both reads stamp their own expiry cutoff; a frozen clock keeps the two
      // queries comparable when they straddle a millisecond.
      jest.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z') });

      try {
        const stale = makeUserGraph();
        db.user.findUnique.mockResolvedValue(stale as unknown as User);
        await service.getUserRoleGraph('user-1');
        const set = jest.spyOn(cache, 'set');

        const tx = { user: { findUnique: jest.fn().mockResolvedValue({ ...stale, roles: [] }) } };
        const result = await service.loadUserRoleGraphWithin(tx as never, 'user-1');

        expect(result).toEqual({ ...stale, roles: [] });
        // The same graph the cached read loads, asked of the transaction.
        const cachedRead = db.user.findUnique.mock.calls[0][0];
        expect(tx.user.findUnique).toHaveBeenCalledWith({
          ...cachedRead,
          where: { ...cachedRead.where, AND: { OR: expect.any(Array) } },
        });
        expect(db.user.findUnique).toHaveBeenCalledTimes(1);
        expect(set).not.toHaveBeenCalled();
        // The cached graph is left alone.
        await expect(service.getUserRoleGraph('user-1')).resolves.toBe(stale);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reads a user under a ban in force as no graph, as better-auth refuses them a sign-in (#747)', async () => {
      const now = new Date('2026-10-22T12:00:00Z');
      jest.useFakeTimers({ now });

      try {
        const tx = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
        await expect(service.loadUserRoleGraphWithin(tx as never, 'user-1')).resolves.toBeNull();

        // Not banned, or banned with an expiry already past.
        expect(tx.user.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'user-1', AND: { OR: [{ banned: null }, { banned: false }, { banExpires: { lte: now } }] } },
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('loadUserRoleGraphs', () => {
    it('reads every user in one read, with the graph and ban rule a single read uses, and caches nothing (#732)', async () => {
      const now = new Date('2026-10-22T12:00:00Z');
      jest.useFakeTimers({ now });

      try {
        const tx = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
        await service.loadUserRoleGraphWithin(tx as never, 'user-1');
        const set = jest.spyOn(cache, 'set');
        const first = makeUserGraph({ id: 'user-1' });
        const second = makeUserGraph({ id: 'user-2' });
        db.user.findMany.mockResolvedValue([first, second] as unknown as User[]);

        const graphs = await service.loadUserRoleGraphs(['user-1', 'user-2']);

        expect(graphs).toEqual(
          new Map([
            ['user-1', first],
            ['user-2', second],
          ]),
        );
        const single = tx.user.findUnique.mock.calls[0][0];
        expect(db.user.findMany).toHaveBeenCalledWith({
          select: single.select,
          where: { id: { in: ['user-1', 'user-2'] }, AND: single.where.AND },
        });
        expect(set).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves out a user the read does not return, as one banned or deleted (#906)', async () => {
      db.user.findMany.mockResolvedValue([makeUserGraph({ id: 'user-1' })] as unknown as User[]);

      const graphs = await service.loadUserRoleGraphs(['user-1', 'user-2']);

      expect(graphs.has('user-2')).toBe(false);
    });

    it('reads nothing for no users', async () => {
      await expect(service.loadUserRoleGraphs([])).resolves.toEqual(new Map());
      expect(db.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getUserRoleGraph', () => {
    it('returns the cached graph without hitting the database on a cache hit', async () => {
      const graph = makeUserGraph();
      db.user.findUnique.mockResolvedValue(graph as unknown as User);
      await service.getUserRoleGraph('user-1');

      const result = await service.getUserRoleGraph('user-1');

      expect(result).toBe(graph);
      expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    });

    it('loads role, household, event, and direct-permission sources (expired excluded) and caches it', async () => {
      const set = jest.spyOn(cache, 'set');
      const graph = makeUserGraph();
      db.user.findUnique.mockResolvedValue(graph as unknown as User);

      const result = await service.getUserRoleGraph('user-1');

      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          select: expect.objectContaining({
            // A retired catalog row (#235) must not reach the graph through a role.
            roles: {
              select: {
                role: {
                  select: {
                    name: true,
                    permissions: { where: { permission: { retiredAt: null } }, select: { permission: true } },
                  },
                },
              },
            },
            // Soft-deleted households must not contribute household-scoped grants.
            householdMember: expect.objectContaining({
              where: { household: { deletedAt: null } },
            }),
            permissions: expect.objectContaining({
              where: {
                OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
                permission: { retiredAt: null },
              },
              select: expect.objectContaining({
                inverted: true,
                resourceType: true,
                resourceId: true,
                expiresAt: true,
                permission: {
                  select: {
                    action: true,
                    subject: true,
                    conditions: true,
                    fields: true,
                    inverted: true,
                  },
                },
              }),
            }),
          }),
        }),
      );
      expect(set).toHaveBeenCalledWith('bge:user:permissions:user-1', expect.anything(), expect.any(Number));
      expect(result).toBe(graph);
    });

    it('returns null and does not cache when the user is missing', async () => {
      db.user.findUnique.mockResolvedValue(null);

      const result = await service.getUserRoleGraph('gone');

      expect(result).toBeNull();
      expect(await cache.get('bge:user:permissions:gone')).toBeUndefined();
    });

    it('serves but does not cache a graph holding no global role', async () => {
      // Every provisioned user holds one, and provisioning writes them all in
      // one transaction, so a graph with none was read before that commit
      // (#490). Caching it would refuse the user for the whole TTL after their
      // roles exist. This request is still refused; the next one reloads.
      const graph = makeUserGraph({ roles: [] });
      db.user.findUnique.mockResolvedValue(graph as unknown as User);

      const result = await service.getUserRoleGraph('user-1');

      expect(result).toBe(graph);
      expect(await cache.get('bge:user:permissions:user-1')).toBeUndefined();
    });

    it('reads provisioning off the global roles alone, not off whatever else the graph grants', async () => {
      // A membership is not the mark provisioning leaves; a global role is. A
      // graph with one and not the other is not a provisioned user's graph.
      const graph = makeUserGraph({
        roles: [],
        householdMember: [{ householdId: 'hh-1', role: null }],
      });
      db.user.findUnique.mockResolvedValue(graph as unknown as User);

      await service.getUserRoleGraph('user-1');

      expect(await cache.get('bge:user:permissions:user-1')).toBeUndefined();
    });

    describe('cache TTL', () => {
      it('uses the default TTL when no permission expires within the window', async () => {
        const set = jest.spyOn(cache, 'set');
        db.user.findUnique.mockResolvedValue(makeUserGraph() as unknown as User);

        await service.getUserRoleGraph('user-1');

        expect(set).toHaveBeenCalledWith(
          'bge:user:permissions:user-1',
          expect.anything(),
          PermissionsService.CACHE_TTL_IN_MILLISECONDS,
        );
      });

      it('clamps the TTL to a soon-to-expire permission', async () => {
        const set = jest.spyOn(cache, 'set');
        const expiresInMs = 30_000;
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() + expiresInMs))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        const ttl = cachedTtl(set, 'bge:user:permissions:user-1');
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(expiresInMs);
      });

      it('floors the TTL when a permission expires sub-floor', async () => {
        const set = jest.spyOn(cache, 'set');
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() + 500))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        const ttl = cachedTtl(set, 'bge:user:permissions:user-1');
        expect(ttl).toBe(PermissionsService.MIN_CACHE_TTL_IN_MILLISECONDS);
      });

      it('ignores already-expired permissions when computing the TTL', async () => {
        const set = jest.spyOn(cache, 'set');
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() - 60_000))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        expect(set).toHaveBeenCalledWith(
          'bge:user:permissions:user-1',
          expect.anything(),
          PermissionsService.CACHE_TTL_IN_MILLISECONDS,
        );
      });

      /**
       * The TTL `cacheKey`'s entry was cached with. A load's first `set` can be
       * its key's version token, not the entry.
       */
      function cachedTtl(set: jest.SpiedFunction<Cache['set']>, cacheKey: string): number {
        return set.mock.calls.find(([key]) => key === cacheKey)?.[2] as number;
      }
    });
  });

  describe('cache invalidation', () => {
    it('apiKeyScopeCacheKey is the single source of truth for the API-key scope format', () => {
      expect(PermissionsService.apiKeyScopeCacheKey('key-1')).toBe('bge:apikey:scopes:key-1');
    });

    it('userGraphCacheKey is the single source of truth for the key format', () => {
      expect(PermissionsService.userGraphCacheKey('user-1')).toBe('bge:user:permissions:user-1');
    });

    it('cacheVersionKey is the single source of truth for the version-key format', () => {
      expect(PermissionsService.cacheVersionKey('bge:user:permissions:user-1')).toBe(
        'bge:cache-version:bge:user:permissions:user-1',
      );
    });

    it('invalidateUser deletes exactly that user graph key and writes it a version token', async () => {
      const del = jest.spyOn(cache, 'del');
      const set = jest.spyOn(cache, 'set');

      await service.invalidateUser('user-1');

      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith('bge:user:permissions:user-1');
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(
        'bge:cache-version:bge:user:permissions:user-1',
        expect.any(String),
        PermissionsService.CACHE_VERSION_TTL_IN_MILLISECONDS,
      );
    });

    it('invalidateUser writes a different token each time', async () => {
      // A repeat would let a load tagged after one eviction count as a hit
      // after the next.
      const versionKey = PermissionsService.cacheVersionKey('bge:user:permissions:user-1');

      await service.invalidateUser('user-1');
      const first = await cache.get(versionKey);
      await service.invalidateUser('user-1');

      expect(await cache.get(versionKey)).not.toBe(first);
    });

    it('invalidateUsers de-dupes and deletes one key per distinct user', async () => {
      const del = jest.spyOn(cache, 'del');

      await service.invalidateUsers(['user-1', 'user-2', 'user-1']);

      expect(del).toHaveBeenCalledTimes(2);
      expect(del).toHaveBeenCalledWith('bge:user:permissions:user-1');
      expect(del).toHaveBeenCalledWith('bge:user:permissions:user-2');
    });

    it('invalidateUsers writes each distinct user a version token', async () => {
      const set = jest.spyOn(cache, 'set');

      await service.invalidateUsers(['user-1', 'user-2', 'user-1']);

      expect(set).toHaveBeenCalledTimes(2);
      for (const userId of ['user-1', 'user-2']) {
        expect(set).toHaveBeenCalledWith(
          PermissionsService.cacheVersionKey(PermissionsService.userGraphCacheKey(userId)),
          expect.any(String),
          PermissionsService.CACHE_VERSION_TTL_IN_MILLISECONDS,
        );
      }
    });

    it('invalidateUsers no-ops on an empty set', async () => {
      const del = jest.spyOn(cache, 'del');
      const set = jest.spyOn(cache, 'set');

      await service.invalidateUsers([]);

      expect(del).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    });

    it('invalidateUsers drops nullish ids before evicting', async () => {
      const del = jest.spyOn(cache, 'del');

      await service.invalidateUsers(['user-1', null, undefined, 'user-1']);

      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith('bge:user:permissions:user-1');
    });

    it('invalidateUser swallows a cache failure (best-effort; TTL is the backstop)', async () => {
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(cache, 'del').mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(service.invalidateUser('user-1')).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'), expect.any(Error));
    });

    it('invalidateUser swallows a failed token write, and logs it apart from a failed delete', async () => {
      // The graph is gone, but a load the eviction overtook can still cache
      // what it read, so the log has to say which of the two failed.
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.spyOn(cache, 'set').mockRejectedValueOnce(new Error('OOM command not allowed'));

      await expect(service.invalidateUser('user-1')).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('version token'), expect.any(Error));
    });

    it('invalidateUsers evicts the rest when one eviction fails', async () => {
      const del = jest.spyOn(cache, 'del').mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(service.invalidateUsers(['user-1', 'user-2'])).resolves.toBeUndefined();
      expect(del).toHaveBeenCalledTimes(2);
    });

    it('invalidateUsers evicts every user across multiple bounded batches', async () => {
      const del = jest.spyOn(cache, 'del');
      const ids = Array.from({ length: PermissionsService.EVICTION_BATCH_SIZE + 5 }, (_, i) => `user-${i}`);

      await service.invalidateUsers(ids);

      expect(del).toHaveBeenCalledTimes(ids.length);
    });
  });

  describe('an eviction and a load of the same graph', () => {
    it('reloads a graph evicted since it was cached', async () => {
      const before = makeUserGraph({ householdMember: [{ householdId: 'hh-1', role: null }] });
      const after = makeUserGraph();
      db.user.findUnique
        .mockResolvedValueOnce(before as unknown as User)
        .mockResolvedValueOnce(after as unknown as User);
      await service.getUserRoleGraph('user-1');

      await service.invalidateUser('user-1');

      await expect(service.getUserRoleGraph('user-1')).resolves.toBe(after);
    });

    it('reloads after an eviction that lands while the graph is loading (#588)', async () => {
      // The load reads a membership, the removal commits and evicts, and only
      // then does the load write what it read. Deleting the key alone left
      // that write served until the TTL.
      const stale = makeUserGraph({ householdMember: [{ householdId: 'hh-1', role: null }] });
      const current = makeUserGraph();
      const load = pauseNextUserLoad(stale);
      db.user.findUnique.mockResolvedValueOnce(current as unknown as User);

      const inFlight = service.getUserRoleGraph('user-1');
      await load.started;
      await service.invalidateUser('user-1');
      load.release();

      // The request that read before the eviction still gets what it read.
      await expect(inFlight).resolves.toBe(stale);
      await expect(service.getUserRoleGraph('user-1')).resolves.toBe(current);
    });

    it('reloads after a bulk eviction that lands while the graph is loading', async () => {
      // Ownership transfers and household deletes evict through invalidateUsers.
      const stale = makeUserGraph({ householdMember: [{ householdId: 'hh-1', role: null }] });
      const current = makeUserGraph();
      const load = pauseNextUserLoad(stale);
      db.user.findUnique.mockResolvedValueOnce(current as unknown as User);

      const inFlight = service.getUserRoleGraph('user-1');
      await load.started;
      await service.invalidateUsers(['user-1', 'user-2']);
      load.release();
      await inFlight;

      await expect(service.getUserRoleGraph('user-1')).resolves.toBe(current);
    });

    it('reloads when the token an eviction wrote is gone by the next read', async () => {
      // The cache can drop the token before the entry it guards: it expires,
      // or a store under memory pressure evicts it. The key then holds no
      // token, which a load the eviction overtook mustn't match.
      const stale = makeUserGraph({ householdMember: [{ householdId: 'hh-1', role: null }] });
      const current = makeUserGraph();
      const load = pauseNextUserLoad(stale);
      db.user.findUnique.mockResolvedValueOnce(current as unknown as User);

      const inFlight = service.getUserRoleGraph('user-1');
      await load.started;
      await service.invalidateUser('user-1');
      load.release();
      await inFlight;
      await cache.del(PermissionsService.cacheVersionKey('bge:user:permissions:user-1'));

      await expect(service.getUserRoleGraph('user-1')).resolves.toBe(current);
    });

    it('caches the graph loaded after an eviction', async () => {
      // The token rejects only what was read before it was written; it mustn't
      // turn every later read into a miss.
      db.user.findUnique.mockResolvedValue(makeUserGraph() as unknown as User);
      await service.invalidateUser('user-1');

      await service.getUserRoleGraph('user-1');
      await service.getUserRoleGraph('user-1');

      expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    });

    /**
     * Makes the next user-graph load wait for the test before it returns
     * `read`. `started` settles once the load has begun, so the version token
     * it is tagged with has already been read or written.
     */
    function pauseNextUserLoad(read: UserWithRoles): { started: Promise<void>; release: () => void } {
      let begin!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (begin = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));

      db.user.findUnique.mockImplementationOnce((() => {
        begin();
        return released.then(() => read);
      }) as never);

      return { started, release };
    }
  });

  describe('getPluginGrantSnapshot (#60)', () => {
    const HOUSEHOLD_UNIT: PluginUnit = { scopeType: 'Household', householdId: 'hh-1' };

    const pluginRow = (overrides: Partial<{ enabled: boolean; uninstalledAt: Date | null }> = {}) => ({
      id: 'plugin-1',
      slug: 'demo-plugin',
      enabled: true,
      uninstalledAt: null,
      ...overrides,
    });

    const grantRow = (
      permissionSlug: string,
      decidedRiskLevel: RiskLevel = RiskLevel.Low,
      // Server is the honest default for these fixtures: condition-free
      // catalog rows (the makePermission default) confer via server consent
      // only, and the unit-scope cases below opt in explicitly.
      scopeType: PluginGrantScope = PluginGrantScope.Server,
    ) => ({
      permissionSlug,
      decidedRiskLevel,
      scopeType,
    });

    const servedUnitRow = { enabled: true, suspendedForConsent: false };

    beforeEach(() => {
      db.plugin.findUnique.mockResolvedValue(pluginRow() as never);
      db.householdPlugin.findUnique.mockResolvedValue(servedUnitRow as never);
      db.userPlugin.findUnique.mockResolvedValue(servedUnitRow as never);
      db.pluginGrant.findMany.mockResolvedValue([] as never);
      db.permission.findMany.mockResolvedValue([] as never);
      db.pluginPermission.findMany.mockResolvedValue([] as never);
    });

    it('returns null when no Plugin row exists (dangling actor)', async () => {
      db.plugin.findUnique.mockResolvedValue(null as never);

      await expect(service.getPluginGrantSnapshot('ghost', HOUSEHOLD_UNIT)).resolves.toBeNull();
    });

    describe('serving predicate', () => {
      it.each<[string, Partial<{ enabled: boolean; uninstalledAt: Date | null }>]>([
        ['the plugin is disabled', { enabled: false }],
        ['the plugin is tombstoned', { uninstalledAt: new Date('2026-08-01T00:00:00Z') }],
      ])('is not servable when %s — and grants are never read', async (_label, overrides) => {
        db.plugin.findUnique.mockResolvedValue(pluginRow(overrides) as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot).toMatchObject({ servable: false, corePermissions: [], ownGrantSlugs: [] });
        expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
      });

      it.each<[string, { enabled: boolean; suspendedForConsent: boolean; dormantReason?: string | null } | null]>([
        ['the household enablement row is missing', null],
        ['the household unit is disabled', { enabled: false, suspendedForConsent: false }],
        ['the household unit is suspended for consent', { enabled: true, suspendedForConsent: true }],
        // Dormancy is the third, independent component (#369, D-CK): the row is
        // enabled and unsuspended, and abilities must still stop resolving.
        [
          'the household row is dormant for scope',
          { enabled: true, suspendedForConsent: false, dormantReason: 'ScopeOrphaned' },
        ],
        [
          'the household row is dormant for configuration',
          { enabled: true, suspendedForConsent: false, dormantReason: 'NeedsConfiguration' },
        ],
      ])('is not servable when %s', async (_label, row) => {
        db.householdPlugin.findUnique.mockResolvedValue(row as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot).toMatchObject({ servable: false });
        expect(db.householdPlugin.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { householdId_pluginId: { householdId: 'hh-1', pluginId: 'plugin-1' } },
          }),
        );
      });

      it('checks the UserPlugin row for user units (#225 parity)', async () => {
        db.userPlugin.findUnique.mockResolvedValue({ enabled: true, suspendedForConsent: true } as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', { scopeType: 'User', userId: 'u-1' });

        expect(snapshot).toMatchObject({ servable: false });
        expect(db.userPlugin.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId_pluginId: { userId: 'u-1', pluginId: 'plugin-1' } } }),
        );
      });

      it('needs no enablement row for Server units — the plugin-level predicate is the whole answer', async () => {
        const snapshot = await service.getPluginGrantSnapshot('plugin-1', { scopeType: 'Server' });

        expect(snapshot).toMatchObject({ servable: true });
        expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
        expect(db.userPlugin.findUnique).not.toHaveBeenCalled();
      });
    });

    describe('grant scoping', () => {
      it('reads Granted rows for the Server sentinel plus the unit coordinates — never another unit', async () => {
        await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              pluginId: 'plugin-1',
              status: PluginGrantStatus.Granted,
              OR: [
                { scopeType: PluginGrantScope.Server, scopeId: SERVER_SCOPE_SENTINEL },
                { scopeType: PluginGrantScope.Household, scopeId: 'hh-1' },
              ],
            }),
          }),
        );
      });

      it('reads only Server rows for a Server unit', async () => {
        await service.getPluginGrantSnapshot('plugin-1', { scopeType: 'Server' });

        expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              OR: [{ scopeType: PluginGrantScope.Server, scopeId: SERVER_SCOPE_SENTINEL }],
            }),
          }),
        );
      });
    });

    describe('grant → snapshot split and guards', () => {
      it('splits surviving grants into core permissions and own-namespace slugs', async () => {
        db.pluginGrant.findMany.mockResolvedValue([
          grantRow('read:game', RiskLevel.Medium),
          grantRow('plugin|demo-plugin|manage:digest'),
        ] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:game', riskLevel: RiskLevel.Medium }),
        ] as never);
        db.pluginPermission.findMany.mockResolvedValue([
          { slug: 'plugin|demo-plugin|manage:digest', riskLevel: RiskLevel.Low },
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions.map((permission) => permission.slug)).toEqual(['read:game']);
        expect(snapshot?.ownGrantSlugs).toEqual(['plugin|demo-plugin|manage:digest']);
        expect(db.pluginPermission.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ pluginId: 'plugin-1' }),
          }),
        );
      });

      it('excludes a grant whose decidedRiskLevel no longer covers the current risk', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('read:game', RiskLevel.Low)] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:game', riskLevel: RiskLevel.High }),
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions).toEqual([]);
      });

      it('keeps a grant decided at or above the current risk', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('read:game', RiskLevel.Critical)] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:game', riskLevel: RiskLevel.High }),
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions.map((permission) => permission.slug)).toEqual(['read:game']);
      });

      it('confers nothing for a grant whose catalog row is gone', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('read:vanished')] as never);
        db.permission.findMany.mockResolvedValue([] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot).toMatchObject({ servable: true, corePermissions: [], ownGrantSlugs: [] });
      });

      it('throws the typed rejection for a grant row naming another plugin’s namespace — corruption, not drift', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('plugin|other-plugin|manage:digest')] as never);

        await expect(service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT)).rejects.toThrow(
          expect.objectContaining({
            reason: 'foreign-namespace-slug',
            permissionSlug: 'plugin|other-plugin|manage:digest',
            pluginSlug: 'demo-plugin',
          }),
        );
      });

      it('throws the typed rejection (not a raw RangeError) for an enveloped-but-unparseable grant slug', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('plugin|demo-plugin')] as never);

        await expect(service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT)).rejects.toThrow(
          expect.objectContaining({ reason: 'malformed-slug', permissionSlug: 'plugin|demo-plugin' }),
        );
      });

      it('a household-scope grant confers a core permission only when its row carries bounding conditions', async () => {
        db.pluginGrant.findMany.mockResolvedValue([
          grantRow('update:calendar', RiskLevel.Low, PluginGrantScope.Household),
        ] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'update:calendar', conditions: { householdId: '{{ unit.householdId }}' } }),
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions.map((permission) => permission.slug)).toEqual(['update:calendar']);
      });

      it('excludes a unit-scope grant over a CONDITION-FREE core permission — nothing bounds it to the unit', async () => {
        // The sharp case: a condition-free High-risk seed consented at
        // household scope would otherwise become an unscoped type-level
        // rule — one unit's consent reading as server-wide authority.
        db.pluginGrant.findMany.mockResolvedValue([
          grantRow('read:event', RiskLevel.High, PluginGrantScope.Household),
        ] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:event', riskLevel: RiskLevel.High, conditions: null }),
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions).toEqual([]);
      });

      it('excludes a granted core permission whose subject drifted to the all wildcard (the wildcard re-check)', async () => {
        db.pluginGrant.findMany.mockResolvedValue([grantRow('read:everything', RiskLevel.Critical)] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:everything', subject: 'all', riskLevel: RiskLevel.Low }),
        ] as never);

        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot?.corePermissions).toEqual([]);
      });

      it('skips the catalog reads entirely when nothing is granted', async () => {
        const snapshot = await service.getPluginGrantSnapshot('plugin-1', HOUSEHOLD_UNIT);

        expect(snapshot).toMatchObject({ servable: true, corePermissions: [], ownGrantSlugs: [] });
        expect(db.permission.findMany).not.toHaveBeenCalled();
        expect(db.pluginPermission.findMany).not.toHaveBeenCalled();
      });
    });
  });
});

function makeApiKeyGraph(scopes: ApikeyWithScopes['scopes'] = []): ApikeyWithScopes {
  return {
    id: 'key-1',
    key: 'bge_test_key',
    referenceId: 'user-1',
    configId: 'config-1',
    permissions: 'manage',
    name: 'Test Key',
    start: null,
    prefix: null,
    enabled: true,
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    rateLimitEnabled: true,
    rateLimitTimeWindow: 86_400_000,
    rateLimitMax: 10,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    metadata: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    scopes: scopes.length
      ? scopes
      : [
          {
            id: 'scope-1',
            apiKeyId: 'key-1',
            permissionId: 'perm-1',
            resourceType: 'Household' as ApikeyWithScopes['scopes'][number]['resourceType'],
            resourceId: null,
            createdAt: new Date(),
            permission: { action: Action.read, subject: 'Household', inverted: false },
          },
        ],
  };
}

/** A provisioned user's graph: every one holds a global role, `User` at the least. */
function makeUserGraph(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  return {
    id: 'user-1',
    roles: [{ role: { name: 'User', permissions: [] } }],
    householdMember: [],
    eventsAttended: [],
    permissions: [],
    ...overrides,
  };
}

function makeGraphPermission(expiresAt: Date | null): UserPermissionWithPermission {
  return {
    inverted: false,
    resourceType: ResourceType.Game,
    resourceId: null,
    expiresAt,
    permission: { action: Action.read, subject: 'Game', conditions: {}, fields: [], inverted: false },
  };
}
