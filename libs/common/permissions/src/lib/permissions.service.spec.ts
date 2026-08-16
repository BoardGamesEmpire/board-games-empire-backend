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
import type { Cache } from 'cache-manager';
import type { ApikeyWithScopes, UserPermissionWithPermission, UserWithRoles } from './interfaces';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let db: MockDatabaseService;
  let cache: jest.Mocked<Pick<Cache, 'get' | 'set' | 'del'>>;

  beforeEach(async () => {
    const {
      module,
      db: mockDb,
      cache: mockCache,
    } = await createTestingModuleWithDb({
      providers: [PermissionsService],
    });

    service = module.get(PermissionsService);
    db = mockDb;
    cache = mockCache;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getApiKeyScopeGraph', () => {
    it('returns the cached graph without hitting the database on a cache hit', async () => {
      const cached = makeApiKeyGraph();
      cache.get.mockResolvedValue(cached);

      const result = await service.getApiKeyScopeGraph('key-1');

      expect(result).toBe(cached);
      expect(db.apikey.findUnique).not.toHaveBeenCalled();
    });

    it('loads the key with scopes + permission triple and caches it on a miss', async () => {
      cache.get.mockResolvedValue(undefined);
      const apiKey = makeApiKeyGraph();
      db.apikey.findUnique.mockResolvedValue(apiKey);

      const result = await service.getApiKeyScopeGraph('key-1');

      expect(db.apikey.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          include: expect.objectContaining({
            scopes: expect.objectContaining({
              include: { permission: { select: { action: true, subject: true, inverted: true } } },
            }),
          }),
        }),
      );
      expect(cache.set).toHaveBeenCalledWith('bge:apikey:scopes:key-1', apiKey, expect.any(Number));
      expect(result).toBe(apiKey);
    });

    it('returns null and does not cache when the key is missing (revoked)', async () => {
      cache.get.mockResolvedValue(undefined);
      db.apikey.findUnique.mockResolvedValue(null);

      const result = await service.getApiKeyScopeGraph('gone');

      expect(result).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('getUserRoleGraph', () => {
    it('returns the cached graph without hitting the database on a cache hit', async () => {
      const cached = makeUserGraph();
      cache.get.mockResolvedValue(cached);

      const result = await service.getUserRoleGraph('user-1');

      expect(result).toBe(cached);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('loads role, household, event, and direct-permission sources (expired excluded) and caches it', async () => {
      cache.get.mockResolvedValue(undefined);
      const graph = makeUserGraph();
      db.user.findUnique.mockResolvedValue(graph as unknown as User);

      const result = await service.getUserRoleGraph('user-1');

      expect(db.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          select: expect.objectContaining({
            // Soft-deleted households must not contribute household-scoped grants.
            householdMember: expect.objectContaining({
              where: { household: { deletedAt: null } },
            }),
            permissions: expect.objectContaining({
              where: { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
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
      expect(cache.set).toHaveBeenCalledWith('bge:user:permissions:user-1', graph, expect.any(Number));
      expect(result).toBe(graph);
    });

    it('returns null and does not cache when the user is missing', async () => {
      cache.get.mockResolvedValue(undefined);
      db.user.findUnique.mockResolvedValue(null);

      const result = await service.getUserRoleGraph('gone');

      expect(result).toBeNull();
      expect(cache.set).not.toHaveBeenCalled();
    });

    describe('cache TTL', () => {
      it('uses the default TTL when no permission expires within the window', async () => {
        cache.get.mockResolvedValue(undefined);
        db.user.findUnique.mockResolvedValue(makeUserGraph() as unknown as User);

        await service.getUserRoleGraph('user-1');

        expect(cache.set).toHaveBeenCalledWith(
          'bge:user:permissions:user-1',
          expect.anything(),
          PermissionsService.CACHE_TTL_IN_MILLISECONDS,
        );
      });

      it('clamps the TTL to a soon-to-expire permission', async () => {
        cache.get.mockResolvedValue(undefined);
        const expiresInMs = 30_000;
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() + expiresInMs))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        const ttl = cache.set.mock.calls[0]?.[2] as number;
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(expiresInMs);
      });

      it('floors the TTL when a permission expires sub-floor', async () => {
        cache.get.mockResolvedValue(undefined);
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() + 500))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        const ttl = cache.set.mock.calls[0]?.[2] as number;
        expect(ttl).toBe(PermissionsService.MIN_CACHE_TTL_IN_MILLISECONDS);
      });

      it('ignores already-expired permissions when computing the TTL', async () => {
        cache.get.mockResolvedValue(undefined);
        const graph = makeUserGraph({
          permissions: [makeGraphPermission(new Date(Date.now() - 60_000))],
        });
        db.user.findUnique.mockResolvedValue(graph as unknown as User);

        await service.getUserRoleGraph('user-1');

        expect(cache.set).toHaveBeenCalledWith(
          'bge:user:permissions:user-1',
          expect.anything(),
          PermissionsService.CACHE_TTL_IN_MILLISECONDS,
        );
      });
    });
  });

  describe('cache invalidation', () => {
    it('userGraphCacheKey is the single source of truth for the key format', () => {
      expect(PermissionsService.userGraphCacheKey('user-1')).toBe('bge:user:permissions:user-1');
    });

    it('invalidateUser deletes exactly that user graph key', async () => {
      await service.invalidateUser('user-1');

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith('bge:user:permissions:user-1');
    });

    it('invalidateUsers de-dupes and deletes one key per distinct user', async () => {
      await service.invalidateUsers(['user-1', 'user-2', 'user-1']);

      expect(cache.del).toHaveBeenCalledTimes(2);
      expect(cache.del).toHaveBeenCalledWith('bge:user:permissions:user-1');
      expect(cache.del).toHaveBeenCalledWith('bge:user:permissions:user-2');
    });

    it('invalidateUsers no-ops on an empty set', async () => {
      await service.invalidateUsers([]);

      expect(cache.del).not.toHaveBeenCalled();
    });

    it('invalidateUsers drops nullish ids before evicting', async () => {
      await service.invalidateUsers(['user-1', null, undefined, 'user-1']);

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith('bge:user:permissions:user-1');
    });

    it('invalidateUser swallows a cache failure (best-effort; TTL is the backstop)', async () => {
      cache.del.mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(service.invalidateUser('user-1')).resolves.toBeUndefined();
    });

    it('invalidateUsers evicts the rest when one eviction fails', async () => {
      cache.del.mockRejectedValueOnce(new Error('redis unreachable'));

      await expect(service.invalidateUsers(['user-1', 'user-2'])).resolves.toBeUndefined();
      expect(cache.del).toHaveBeenCalledTimes(2);
    });

    it('invalidateUsers evicts every user across multiple bounded batches', async () => {
      const ids = Array.from({ length: PermissionsService.EVICTION_BATCH_SIZE + 5 }, (_, i) => `user-${i}`);

      await service.invalidateUsers(ids);

      expect(cache.del).toHaveBeenCalledTimes(ids.length);
    });
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

      it.each<[string, { enabled: boolean; suspendedForConsent: boolean } | null]>([
        ['the household enablement row is missing', null],
        ['the household unit is disabled', { enabled: false, suspendedForConsent: false }],
        ['the household unit is suspended for consent', { enabled: true, suspendedForConsent: true }],
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
          grantRow('read:user:profile', RiskLevel.High, PluginGrantScope.Household),
        ] as never);
        db.permission.findMany.mockResolvedValue([
          makePermission({ slug: 'read:user:profile', riskLevel: RiskLevel.High, conditions: null }),
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

function makeUserGraph(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  return {
    id: 'user-1',
    roles: [],
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
