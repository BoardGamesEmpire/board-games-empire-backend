import { PermissionsService } from '@bge/permissions';
import { API_CACHE_NAMESPACE } from './cache.config';

/**
 * The key globs the boot sequence removes after a catalog reconcile that wrote
 * rows (#236): the cached ability graphs and API-key scope graphs, under the
 * physical keys the CacheModule writes, its Keyv namespace in front of the
 * logical key `PermissionsService` builds. Lives beside the namespace so the
 * two cannot drift apart unnoticed; the spec beside it writes through Keyv and
 * checks that the patterns match what lands.
 */
export function bootstrapCacheFlushPatterns(): readonly string[] {
  return [PermissionsService.userGraphCacheKey('*'), PermissionsService.apiKeyScopeCacheKey('*')].map(
    (key) => `${API_CACHE_NAMESPACE}:${key}`,
  );
}
