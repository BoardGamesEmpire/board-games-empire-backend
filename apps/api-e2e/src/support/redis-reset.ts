import Redis from 'iovalkey';
import { E2E_OWNS_REDIS_VAR, E2E_REDIS_FLUSH_OK_VAR, E2E_REDIS_URL_VAR } from './e2e-env';

/**
 * Whether destructive Redis helpers are permitted against the currently
 * configured server: the harness provisioned it (`global-setup` publishes
 * ownership for BOTH provisioning modes, so a stale `'true'` inherited
 * from the environment cannot survive), or the developer explicitly
 * acknowledged that their escape-hatch server is disposable.
 *
 * Absent means "globalSetup never ran", which is a refusal — the one
 * mistake this file must make impossible is flushing a Redis nobody
 * declared expendable.
 */
export function mayFlushRedis(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[E2E_OWNS_REDIS_VAR] === 'true' || env[E2E_REDIS_FLUSH_OK_VAR] === 'true';
}

/**
 * The rate-limit namespace, mirroring `KEY_PREFIX` in
 * `apps/api/src/app/lib/redis-throttler.storage.ts`. Spelled out rather than
 * imported because `api-e2e` has no path to `apps/api` — the same seam that
 * keeps the limiter's Lua untested (#464).
 */
const THROTTLE_KEY_PATTERN = 'bge:throttle:*';

/**
 * Deletes every rate-limit bucket, and nothing else.
 *
 * Throttle counters used to be an in-process `Map` that died with the API
 * child, so a run started clean by accident. Since #341 they live in Redis and
 * outlive the process, which matters the moment the suite is pointed at a
 * server it did not provision (`BGE_E2E_REDIS_URL`): yesterday's buckets are
 * still there, and an hour-long block with them, so a run fails with `429`s
 * that have nothing to do with the behaviour under test.
 *
 * Unguarded, unlike {@link resetRedis}, and deliberately so — this cannot
 * destroy anything a developer would miss. It is also run unconditionally
 * rather than only on the external path, so the sweep that matters on a reused
 * server is the same one CI exercises every run.
 *
 * `SCAN` rather than `KEYS`: the sweep runs against whatever server the
 * developer named, and `KEYS` on a large one blocks it.
 */
export async function sweepThrottleBuckets(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const client = connect(env);
  let cursor = '0';
  let removed = 0;

  try {
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', THROTTLE_KEY_PATTERN, 'COUNT', 500);
      cursor = next;

      if (keys.length > 0) {
        removed += await client.del(...keys);
      }
    } while (cursor !== '0');
  } finally {
    await client.quit();
  }

  return removed;
}

/**
 * A short-lived TEST-OWNED connection built from the same `REDIS_*` environment
 * the harness pointed the API at — the cache database, which is where both the
 * app cache and the rate-limit buckets live.
 */
function connect(env: NodeJS.ProcessEnv): Redis {
  const host = env['REDIS_HOST'];
  const port = Number(env['REDIS_PORT']);

  if (!host || !Number.isFinite(port)) {
    throw new Error('REDIS_HOST/PORT are not set — did the e2e globalSetup run?');
  }

  return new Redis({
    host,
    port,
    username: env['REDIS_USERNAME'] || undefined,
    password: env['REDIS_PASSWORD'] || undefined,
    db: Number(env['REDIS_DATABASE']) || 0,
  });
}

/**
 * Wipes the ephemeral Redis server — every logical database, so cached
 * abilities, sessions, AND queued BullMQ jobs all go (`FLUSHALL` is
 * server-wide, which is exactly the isolation the sweep wants; the three
 * app connections share one server on different database indices). Uses a
 * short-lived TEST-OWNED connection built from the same `REDIS_*`
 * environment the harness pointed the API at.
 *
 * Guarded: refuses to run unless the harness provisioned the container
 * itself, or the developer explicitly acknowledged their escape-hatch
 * Redis is disposable. Wiping a shared dev Redis by accident is the one
 * mistake this file must make impossible.
 */
export async function resetRedis(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!mayFlushRedis(env)) {
    throw new Error(
      `Refusing to FLUSHALL a Redis the harness did not provision. ` +
        `Set ${E2E_REDIS_FLUSH_OK_VAR}=true if the server at ${E2E_REDIS_URL_VAR} is disposable.`,
    );
  }

  const client = connect(env);

  try {
    await client.flushall();
  } finally {
    await client.quit();
  }
}
