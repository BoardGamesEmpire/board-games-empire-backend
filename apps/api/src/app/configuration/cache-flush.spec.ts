import { bootstrapCacheFlushPatterns } from './cache-flush';

// The boot flush SCANs physical keys. The permissions cache writes each key
// under `cacheStoreKey(PERMISSIONS_CACHE_NAMESPACE, key)`, and `@bge/redis`
// pins that against the adapter; this pins the patterns to the same names,
// spelled out because docs/BOOTSTRAP.md gives them to operators. A change to
// the namespace, the store's prefix or a PermissionsService key format moves
// the keys, and fails here before it moves them unannounced.

describe('bootstrapCacheFlushPatterns (#236, #449, #786)', () => {
  it('names the physical keys of both permission graphs and their version tokens, and nothing else', () => {
    expect(bootstrapCacheFlushPatterns()).toEqual([
      'namespace:permissions:cache:bge:user:permissions:*',
      'namespace:permissions:cache:bge:cache-version:bge:user:permissions:*',
      'namespace:permissions:cache:bge:apikey:scopes:*',
      'namespace:permissions:cache:bge:cache-version:bge:apikey:scopes:*',
    ]);
  });
});
