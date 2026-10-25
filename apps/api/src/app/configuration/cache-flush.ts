import { PERMISSIONS_CACHE_NAMESPACE, PermissionsService } from '@bge/permissions';
import { cacheStoreKey } from '@bge/redis';

/**
 * The key globs the boot sequence removes after a catalog reconcile that wrote
 * rows (#236): the cached ability graphs and API-key scope graphs, and the
 * version tokens that guard them, under the physical keys the permissions
 * cache writes: `cacheStoreKey` puts the store's prefix and namespace in front
 * of the logical key `PermissionsService` builds. That is the store every
 * process reads, so the flush reaches the worker's and the gateway worker's
 * graphs as well as the api's (#786). Removing the tokens covers a graph
 * another process loaded before the commit and cached after the flush: it
 * carries a token the flush removed, so its next read misses. The spec beside
 * this pins the patterns, and `@bge/redis` pins that the store writes there.
 */
export function bootstrapCacheFlushPatterns(): readonly string[] {
  return [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')]
    .flatMap((key) => [key, PermissionsService.cacheVersionKey(key)])
    .map((key) => cacheStoreKey(PERMISSIONS_CACHE_NAMESPACE, key));
}
