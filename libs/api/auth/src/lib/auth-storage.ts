import { createCacheStore, type Redis } from '@bge/redis';
import type { BetterAuthOptions } from 'better-auth';
import type Keyv from 'keyv';

/**
 * better-auth's `secondaryStorage`: where it keeps sessions, verification
 * values and rate-limit counts. Every TTL it passes is in seconds.
 */
export type AuthStorage = NonNullable<BetterAuthOptions['secondaryStorage']>;

/**
 * Where better-auth's keys sit in the store. Unchanged from when the shared
 * cache held them, so a key's name in Redis is the same as before (#640).
 */
const KEY_PREFIX = 'auth_';

/**
 * The api's cache namespace, `API_CACHE_NAMESPACE` in the api's
 * `cache.config.ts`, which a lib can't import. Sharing it keeps better-auth's
 * keys where they were (`namespace:api:cache:auth_*`). The api's boot flush
 * removes only permission keys under it, so sessions survive a restart.
 */
const STORE_NAMESPACE = 'api:cache';

/**
 * better-auth's secondary storage over a Keyv store of its own (#640).
 *
 * - **TTLs are converted.** better-auth gives every TTL in seconds, and Keyv
 *   takes milliseconds. Passed through as they were, sessions lasted 10
 *   minutes instead of 7 days, verification values (such as a reset link's)
 *   1/1000th of their life, and a rate-limit count 10 milliseconds, so the
 *   limiter never tripped.
 * - **An entry with no time left is not written.** better-auth floors a TTL
 *   computed from an expiry, so an entry in its last second arrives with 0,
 *   which Keyv reads as "no expiry". The entry it would replace, if any, is
 *   left on its own TTL. For a session that is under a second; a user's
 *   active-sessions list can keep naming a session deleted in that second,
 *   which is harmless, since better-auth skips a listed session it cannot
 *   find.
 * - **Failures are raised.** The store must be built with `throwOnErrors`,
 *   and one that is not is refused here. Otherwise Keyv resolves a failed read
 *   as a miss and a failed write or delete as `false`, so better-auth would
 *   issue a cookie for a session it never saved, and a sign-out could not
 *   tell that the session survived (#487). A failed read is an error too, so
 *   with Redis unreachable no session can be read wherever one is checked,
 *   over HTTP or WebSocket, rather than reading as signed out. better-auth's
 *   rate limiter fails first on every `/api/auth` request, reading its count
 *   ahead of every hook, rather than letting the request through unlimited.
 *
 * There is no `increment` yet, so better-auth counts requests against a rate
 * limit with a read and then a write, which concurrent requests can slip
 * between (#832).
 */
export function createAuthStorage(store: Keyv): AuthStorage {
  if (!store.throwOnErrors) {
    throw new Error(
      "better-auth's storage needs a store built with throwOnErrors, so a failed Redis call reaches better-auth.",
    );
  }

  return {
    get: (key) => store.get(`${KEY_PREFIX}${key}`),

    async set(key, value, ttl) {
      if (ttl !== undefined && ttl <= 0) {
        return;
      }

      await store.set(`${KEY_PREFIX}${key}`, value, ttl === undefined ? undefined : ttl * 1000);
    },

    async delete(key) {
      await store.delete(`${KEY_PREFIX}${key}`);
    },
  };
}

/** {@link createAuthStorage} over the shared cache client, the api's Redis connection for caches. */
export function createRedisAuthStorage(client: Redis): AuthStorage {
  return createAuthStorage(createCacheStore(client, STORE_NAMESPACE, { throwOnErrors: true }));
}
