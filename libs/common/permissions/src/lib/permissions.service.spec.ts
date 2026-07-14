import { Action, ResourceType, User } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
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
