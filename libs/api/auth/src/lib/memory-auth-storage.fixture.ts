import type Keyv from 'keyv';
import { createAuthStorage, type CompleteAuthStorage } from './auth-storage';

/** How many requests a rate-limit key has counted, and when its window closes. */
interface CountWindow {
  count: number;
  expiresAt: number;
}

/**
 * {@link createAuthStorage} over `store`, with the one-step count and
 * read-and-delete better-auth 1.7 requires of a storage (#1016), done as a
 * read and then a write. For specs only, which run in one process where
 * nothing races: the api's storage is `createRedisAuthStorage`, where each
 * step is a single Redis command. `tsconfig.lib.json` excludes a fixture, so
 * this stays out of the lib's build and no api code can reach for it.
 *
 * A count writes through {@link createAuthStorage}'s `set`, so its window is
 * kept as that converts it, in seconds.
 */
export function memoryAuthStorage(store: Keyv): CompleteAuthStorage {
  const storage = createAuthStorage(store);

  return {
    ...storage,

    async increment(key, ttl) {
      const now = Date.now();
      const stored = await storage.get(key);
      const previous: CountWindow | undefined = typeof stored === 'string' ? JSON.parse(stored) : undefined;

      // The window opens with the first request and later ones don't push it
      // out, as better-auth documents `increment`.
      const window: CountWindow =
        previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + ttl * 1000 };
      window.count += 1;

      await storage.set(key, JSON.stringify(window), (window.expiresAt - now) / 1000);

      return window.count;
    },

    async getAndDelete(key) {
      const value = await storage.get(key);
      await storage.delete(key);

      return value;
    },
  };
}
