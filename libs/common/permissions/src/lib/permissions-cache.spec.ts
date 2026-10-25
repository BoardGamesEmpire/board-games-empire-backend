import { cacheStoreKey, type Redis } from '@bge/redis';
import { createPermissionsCache, PERMISSIONS_CACHE_NAMESPACE } from './permissions-cache';

/**
 * Stands in for the shared cache client: records each SET and keeps the
 * strings it is given. The adapter takes an object whose `options` carry a
 * `family` as an open client, and opens a connection of its own for anything
 * else.
 */
function fakeClient() {
  const sets: unknown[][] = [];
  const strings = new Map<string, string>();
  const client = {
    options: { family: 4 },
    on: () => client,
    async set(key: string, value: string, ...args: unknown[]) {
      sets.push([key, ...args]);
      strings.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
  };

  return { client: client as unknown as Redis, sets };
}

describe('createPermissionsCache (#786)', () => {
  it('writes a graph under the shared namespace, the key every process reads and the boot flush unlinks', async () => {
    const { client, sets } = fakeClient();
    const cache = createPermissionsCache(client);

    await cache.set('bge:user:permissions:u1', { roles: [] }, 60_000);

    expect(sets).toEqual([[cacheStoreKey(PERMISSIONS_CACHE_NAMESPACE, 'bge:user:permissions:u1'), 'PX', 60_000]]);
    await expect(cache.get('bge:user:permissions:u1')).resolves.toEqual({ roles: [] });
  });

  it('sets no TTL of its own, so a write keeps only the TTL PermissionsService passes', async () => {
    const { client, sets } = fakeClient();
    const cache = createPermissionsCache(client);

    await cache.set('bge:user:permissions:u1', { roles: [] });

    expect(sets).toEqual([[cacheStoreKey(PERMISSIONS_CACHE_NAMESPACE, 'bge:user:permissions:u1')]]);
  });
});
