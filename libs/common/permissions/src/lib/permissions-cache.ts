import { createCacheStore, type Redis } from '@bge/redis';
import { createCache, type Cache } from 'cache-manager';

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
 */
export function createPermissionsCache(client: Redis): Cache {
  return createCache({ stores: [createCacheStore(client, PERMISSIONS_CACHE_NAMESPACE)] });
}
