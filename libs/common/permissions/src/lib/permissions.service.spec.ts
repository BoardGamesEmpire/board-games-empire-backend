import { Action } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { Cache } from 'cache-manager';
import type { ApikeyWithScopes } from './interfaces';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let db: MockDatabaseService;
  let cache: jest.Mocked<Pick<Cache, 'get' | 'set'>>;

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
