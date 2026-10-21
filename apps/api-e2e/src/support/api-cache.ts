import { cacheStoreKey } from '@bge/redis';
import { connectToHarnessRedis, requireDisposableRedis } from './redis-reset';

/**
 * The api's `API_CACHE_NAMESPACE` (`apps/api/src/app/configuration/cache.config.ts`).
 * The api's store keeps a logical key under `cacheStoreKey(API_CACHE_NAMESPACE, key)`,
 * and {@link apiCacheKey} composes the same name. Spelled out rather than
 * imported, as `THROTTLE_KEY_PATTERN` is in `redis-reset.ts`: `api-e2e` has no
 * path to `apps/api`.
 */
export const API_CACHE_NAMESPACE = 'api:cache';

/** The Redis key the api's cache keeps `logicalKey` under. */
export function apiCacheKey(logicalKey: string): string {
  return cacheStoreKey(API_CACHE_NAMESPACE, logicalKey);
}

/**
 * The logical key the api's response cache writes for a request, laid out as
 * `UserAwareCacheInterceptor` lays it out: the caller's namespace (`anon`,
 * `user:<id>` or `apikey:<id>`), the request locale, then the URL. Spelled out
 * for the reason {@link API_CACHE_NAMESPACE} is.
 */
export function responseCacheKey(namespace: string, url: string, locale = 'en'): string {
  return `${namespace}:${locale}:${url}`;
}

/**
 * Whether the api's cache holds `logicalKey` right now, read from the Redis
 * the harness pointed the api at.
 *
 * A deliberate exception to the suite's black-box rule, the second after
 * `lock-barrier.ts`, and narrow in the same way: it reads a fact no HTTP
 * response carries. A later request can succeed either because nothing stale
 * was cached or because something evicted it afterwards, and a fix that
 * prevents the first cannot be told apart from one that relies on the second
 * except by asking which. Specs assert behaviour over HTTP beside it; this
 * pins the mechanism.
 */
export async function apiCacheHas(logicalKey: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const client = connectToHarnessRedis(env);

  try {
    return (await client.exists(apiCacheKey(logicalKey))) === 1;
  } finally {
    await client.quit();
  }
}

/**
 * How many milliseconds the key the api keeps `logicalKey` under has left to
 * live, as Redis's PTTL reports it: `-2` when there is no such key, `-1` when
 * it never expires. An exception to the black-box rule for the reason
 * {@link apiCacheHas} is: no HTTP response says when a session will be
 * dropped, and a session dropped early looks, until then, like one kept.
 */
export async function apiCacheTtlMs(logicalKey: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const client = connectToHarnessRedis(env);

  try {
    return await client.pttl(apiCacheKey(logicalKey));
  } finally {
    await client.quit();
  }
}

/**
 * The value the api's cache holds for `logicalKey`, exactly as stored, or
 * `null` when it holds none. {@link apiCacheWriteRaw} puts it back.
 */
export async function apiCacheReadRaw(
  logicalKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const client = connectToHarnessRedis(env);

  try {
    return await client.get(apiCacheKey(logicalKey));
  } finally {
    await client.quit();
  }
}

/**
 * Writes `raw` under `logicalKey` in the api's cache, exactly as given, to
 * expire in `ttlMs`.
 *
 * The suite's only write to the api's cache, and an exception to the
 * black-box rule for the reason {@link apiCacheHas} is. Some writes the api
 * makes can't be timed over HTTP: a request that loaded something before a
 * change and writes it to the cache after the change's eviction. Writing back
 * a value read earlier with {@link apiCacheReadRaw} stands in for that late
 * write: the same bytes, landing after the eviction.
 *
 * Refused on a Redis the harness didn't provision, since an api sharing it
 * would serve what this plants.
 */
export async function apiCacheWriteRaw(
  logicalKey: string,
  raw: string,
  ttlMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  requireDisposableRedis('write to the api cache', env);

  const client = connectToHarnessRedis(env);

  try {
    await client.set(apiCacheKey(logicalKey), raw, 'PX', ttlMs);
  } finally {
    await client.quit();
  }
}

/**
 * The size of every set under `namespace:` on the Redis the harness pointed
 * the api at, by name. `@keyv/valkey` keeps such a set per store when its
 * index is on, adds every key the store writes, and removes one only on a
 * delete through the store, so a key that expires stays a member (#449).
 */
export async function cacheIndexSizes(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, number>> {
  const client = connectToHarnessRedis(env);
  const sizes: Record<string, number> = {};

  try {
    for await (const page of client.scanStream({ match: 'namespace:*', type: 'set', count: 500 })) {
      for (const key of page as string[]) {
        sizes[key] = await client.scard(key);
      }
    }
  } finally {
    await client.quit();
  }

  return sizes;
}
