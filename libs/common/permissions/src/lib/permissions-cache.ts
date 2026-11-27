import type { Redis } from '@bge/redis';
import { createCacheStore } from '@bge/redis';
import type { Cache, CreateCacheOptions } from 'cache-manager';
import { createCache } from 'cache-manager';

/**
 * The namespace permission graphs and their version tokens live under, the
 * same in every process, so an eviction in any process, and the api's boot
 * flush, reach the graph every process reads (#786). The boot flush composes
 * its patterns from this.
 */
export const PERMISSIONS_CACHE_NAMESPACE = 'permissions:cache';

/** Injection token for the cache {@link createPermissionsCache} builds; `PermissionsService` is its only reader. */
export const PERMISSIONS_CACHE = Symbol('PERMISSIONS_CACHE');

/**
 * The permission-graph cache over the shared cache client, under
 * {@link PERMISSIONS_CACHE_NAMESPACE}. It sets no default TTL: every write
 * `PermissionsService` makes passes its own.
 *
 * Nothing disconnects it. `Cache.disconnect()` would quit the shared client,
 * which `RedisLifecycleManager` owns.
 *
 * cache-manager 7 declares its stores with Keyv 5, and the store is Keyv 6.
 * The calls `PermissionsService` makes (`get`, `mget`, `set`, `del`) reach
 * Keyv methods that kept their shape. `wrap` and `ttl` don't: they read a raw
 * entry with `get(key, { raw: true })`, which Keyv 6 ignores, so `wrap` would
 * miss every time.
 */
export function createPermissionsCache(client: Redis): Cache {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cache-manager's declarations take Keyv 5's class, and every store here is Keyv 6; see above
  const store = createCacheStore(client, PERMISSIONS_CACHE_NAMESPACE) as unknown as CacheStore;

  return createCache({ stores: [store] });
}

type CacheStore = NonNullable<CreateCacheOptions['stores']>[number];
