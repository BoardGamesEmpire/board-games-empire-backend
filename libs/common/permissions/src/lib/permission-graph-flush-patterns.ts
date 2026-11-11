import { cacheStoreKey } from '@bge/redis';
import { PERMISSIONS_CACHE_NAMESPACE } from './permissions-cache';
import { PermissionsService } from './permissions.service';

/**
 * The key globs removed after a reconcile of the permission catalog that
 * wrote rows at boot (#236), and after an edit of the permission catalog
 * commits at runtime (#772): the cached ability graphs and API-key scope
 * graphs, and the version tokens that guard them, under the physical keys the
 * permissions cache writes: `cacheStoreKey` puts the store's prefix and
 * namespace in front of the logical key `PermissionsService` builds. That is
 * the store every process reads, so the flush reaches the worker's and the
 * gateway worker's graphs as well as the api's (#786). Removing the tokens
 * covers a graph another process loaded before the commit and cached after
 * the flush: it carries a token the flush removed, so its next read misses.
 * The spec beside this pins the patterns, and `@bge/redis` pins that the store
 * writes there.
 */
export function permissionGraphFlushPatterns(): readonly string[] {
  return [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')]
    .flatMap((key) => [key, PermissionsService.cacheVersionKey(key)])
    .map((key) => cacheStoreKey(PERMISSIONS_CACHE_NAMESPACE, key));
}
