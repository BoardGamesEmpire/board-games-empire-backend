import { PermissionsService } from '@bge/permissions';
import { cacheStoreKey } from '@bge/redis';
import { API_CACHE_NAMESPACE } from './cache.config';

/**
 * The key globs the boot sequence removes after a catalog reconcile that wrote
 * rows (#236): the cached ability graphs and API-key scope graphs, and the
 * version tokens that guard them, under the physical keys the CacheModule
 * writes: `cacheStoreKey` puts the store's prefix and namespace in front of
 * the logical key `PermissionsService` builds. Removing the tokens covers a
 * graph another api process loaded before the commit and cached after the
 * flush: it carries a token the flush removed, so its next read misses. Lives
 * beside the namespace so the two cannot drift apart unnoticed. The spec
 * beside it pins the patterns, and `@bge/redis` pins that the store writes
 * there.
 */
export function bootstrapCacheFlushPatterns(): readonly string[] {
  return [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')]
    .flatMap((key) => [key, PermissionsService.cacheVersionKey(key)])
    .map((key) => cacheStoreKey(API_CACHE_NAMESPACE, key));
}
