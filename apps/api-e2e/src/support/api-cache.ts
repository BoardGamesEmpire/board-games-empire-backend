import { connectToHarnessRedis } from './redis-reset';

/**
 * The api's `API_CACHE_NAMESPACE` (`apps/api/src/app/configuration/cache.config.ts`).
 * Keyv stores a logical key as `${namespace}:${key}`, so this is the prefix of
 * every physical key the api's cache writes. Spelled out rather than imported,
 * as `THROTTLE_KEY_PATTERN` is in `redis-reset.ts`: `api-e2e` has no path to
 * `apps/api`.
 */
export const API_CACHE_NAMESPACE = 'api:cache';

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
    return (await client.exists(`${API_CACHE_NAMESPACE}:${logicalKey}`)) === 1;
  } finally {
    await client.quit();
  }
}
