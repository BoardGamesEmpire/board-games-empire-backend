import { cacheStoreKey, createCacheStore, type Redis } from '@bge/redis';
import type { BetterAuthOptions } from 'better-auth';
import type Keyv from 'keyv';

/**
 * What a Keyv store can do of better-auth's `secondaryStorage`: where it keeps
 * sessions, verification values and rate-limit counts. Every TTL it passes is
 * in seconds. Without the one-step count and read-and-delete, which Keyv can't
 * do, it is not enough to give better-auth: see {@link CompleteAuthStorage}.
 */
export type AuthStorage = Omit<NonNullable<BetterAuthOptions['secondaryStorage']>, 'increment' | 'getAndDelete'>;

/**
 * {@link AuthStorage} with the one-step count and read-and-delete, which
 * better-auth 1.7 requires of a storage (#1016). Before, it fell back to a read
 * and then a write, or a read and then a delete, when a storage had neither.
 */
export type CompleteAuthStorage = NonNullable<BetterAuthOptions['secondaryStorage']>;

/**
 * Where better-auth's keys sit in the store. Unchanged from when the shared
 * cache held them, so a key's name in Redis is the same as before (#640).
 */
const KEY_PREFIX = 'auth_';

/**
 * The api's cache namespace, `API_CACHE_NAMESPACE` in the api's
 * `cache.config.ts`, which a lib can't import. Sharing it keeps better-auth's
 * keys where they were (`namespace:api:cache:auth_*`). The api's boot flush
 * removes nothing under it: it removes permission keys, which live under
 * `namespace:permissions:cache:` (#786), so sessions survive a restart.
 */
const STORE_NAMESPACE = 'api:cache';

/**
 * Counts a request against a rate limit and returns the new count (#832). A
 * Lua script, which Redis runs (not Node), so the count and its expiry are one
 * command. Concurrent requests each get a count of their own, and a failed
 * script rejects `EVAL`, where a MULTI's `exec()` would resolve with the error
 * beside its reply. `NX` sets the expiry only on a count that has none, so a
 * later request in the window doesn't push it out.
 */
const INCREMENT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX')
return count`;

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
 *   rate limiter fails first on every `/api/auth` request, counting it ahead
 *   of every hook, rather than letting the request through unlimited.
 *
 * Keyv can't count, or read and delete, in one step, and better-auth 1.7
 * requires both of its storage (#1016). So this alone is not a storage to give
 * `authFactory`: {@link createRedisAuthStorage} adds both steps.
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

/**
 * {@link createAuthStorage} over the shared cache client, the api's Redis
 * connection for caches.
 *
 * - **A rate-limit count is one step** (#832). better-auth 1.7 counts through
 *   `increment` and throws without one. With a read and then a write,
 *   concurrent requests could all read the same count, and all get through.
 *   Counted here, they are counted across every api process sharing the
 *   Redis. A count that fails is raised, as every call here is.
 * - **A single-use value is used in one step** (#888). The api keeps
 *   verification values in this storage, and better-auth 1.7 consumes one
 *   through `getAndDelete`, which it requires, with no lock around it: its
 *   lock, which spans one process only, covers just a value kept in the
 *   database. So single use rests on this step. `GETDEL` gives a value, such
 *   as a reset link's, to exactly one of two api processes using it at once.
 *   It returns what `get` would: the value inside Keyv's envelope, or nothing
 *   once the envelope's expiry has passed.
 */
export function createRedisAuthStorage(client: Redis): CompleteAuthStorage {
  const store = createCacheStore(client, STORE_NAMESPACE, { throwOnErrors: true });

  return {
    ...createAuthStorage(store),

    async increment(key, ttl) {
      // Rounded up, because PEXPIRE takes whole milliseconds and a window such
      // as 1.0005 s would fail the script after its INCR.
      return Number(await client.eval(INCREMENT_SCRIPT, 1, physicalKey(key), Math.ceil(ttl * 1000)));
    },

    async getAndDelete(key) {
      const raw = await client.getdel(physicalKey(key));
      if (raw === null) {
        return undefined;
      }

      const envelope = await store.deserializeData<unknown>(raw);
      if (!envelope || (typeof envelope.expires === 'number' && Date.now() > envelope.expires)) {
        return undefined;
      }

      return envelope.value;
    },
  };
}

/** The Redis key the store keeps better-auth's `key` under, for a command sent around the store. */
function physicalKey(key: string): string {
  return cacheStoreKey(STORE_NAMESPACE, `${KEY_PREFIX}${key}`);
}
