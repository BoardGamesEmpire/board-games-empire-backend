import { apiCacheKey } from './api-cache';
import { connectToHarnessRedis, requireDisposableRedis } from './redis-reset';

/**
 * The Redis key a session is stored under: better-auth's `<token>`, behind its
 * storage's `auth_` prefix (`auth-storage.ts`), in the api's cache.
 */
function storedSessionKey(token: string): string {
  return apiCacheKey(`auth_${token}`);
}

/**
 * Makes the session `token` names one signed in `ageMs` ago, by rewriting the
 * `createdAt` it is stored with (#913). The session keeps its time to live,
 * its expiry and everything else it holds, so it still signs its user in.
 *
 * A write to a store the api reads, the suite's second after
 * `permissionsCacheWriteRaw`, and an exception to the black-box rule for the
 * same reason: the state it sets up can't be reached over HTTP in a test's
 * time. No route makes a session older, so a link from a stale one could only
 * be tried after waiting out `session.freshAge`, a day. better-auth reads a
 * session's age from `createdAt` alone, so changing it stands in for the wait.
 * Specs assert the refusal over HTTP; this only ages the session.
 *
 * Sessions live only in Redis, as `@keyv/valkey` writes them: Keyv's
 * envelope, `{ value, expires }`, whose `value` is the JSON better-auth wrote,
 * `{ session, user }`. A value of any other shape throws, so a change in how
 * sessions are stored fails here, rather than leaving a fresh session for a
 * test to take as a stale one.
 *
 * Refused on a Redis the harness didn't provision, since an api sharing it
 * would serve what this writes.
 */
export async function ageStoredSession(
  token: string,
  ageMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  requireDisposableRedis('age a stored session', env);

  const key = storedSessionKey(token);
  const client = connectToHarnessRedis(env);

  try {
    const raw = await client.get(key);
    const ttlMs = await client.pttl(key);
    if (raw === null || ttlMs <= 0) {
      throw new Error(`No session with a time to live is stored under ${key} (PTTL ${ttlMs})`);
    }

    const envelope = JSON.parse(raw) as { value?: unknown };
    const stored = typeof envelope.value === 'string' ? (JSON.parse(envelope.value) as unknown) : undefined;
    if (!isStoredSession(stored)) {
      throw new Error(`The value under ${key} is not a session as better-auth stores one: ${raw}`);
    }

    stored.session.createdAt = new Date(Date.now() - ageMs).toISOString();

    await client.set(key, JSON.stringify({ ...envelope, value: JSON.stringify(stored) }), 'PX', ttlMs);
  } finally {
    await client.quit();
  }
}

/** Whether `value` is better-auth's stored `{ session, user }`, with the `createdAt` a session's age is read from. */
function isStoredSession(value: unknown): value is { session: { createdAt: string } } {
  const session = (value as { session?: { createdAt?: unknown } } | null | undefined)?.session;

  return typeof session?.createdAt === 'string';
}
