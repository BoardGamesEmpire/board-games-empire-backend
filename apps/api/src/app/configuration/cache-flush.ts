import { PermissionsService } from '@bge/permissions';
import { API_CACHE_NAMESPACE } from './cache.config';

/**
 * The key globs the boot sequence removes after a catalog reconcile that wrote
 * rows (#236): the cached ability graphs and API-key scope graphs, and the
 * version tokens that guard them, under the physical keys the CacheModule
 * writes, its Keyv namespace in front of the logical key `PermissionsService`
 * builds. Removing the tokens covers a graph another instance loaded before
 * the commit and cached after the flush: it carries a token the flush removed,
 * so its next read misses. Lives beside the namespace so the two cannot drift
 * apart unnoticed; the spec beside it writes through Keyv and checks that the
 * patterns match what lands.
 */
export function bootstrapCacheFlushPatterns(): readonly string[] {
  return [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')]
    .flatMap((key) => [key, PermissionsService.cacheVersionKey(key)])
    .map((key) => `${API_CACHE_NAMESPACE}:${key}`);
}
