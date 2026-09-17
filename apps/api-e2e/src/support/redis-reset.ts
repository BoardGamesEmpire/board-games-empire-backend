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
 * GUARDED on the same policy as {@link resetRedis}, which this deliberately did
 * not do at first. The reasoning then was that rate-limit counters cost nobody
 * anything to lose — true of a developer's data, and false of the thing they
 * actually are. If `BGE_E2E_REDIS_URL` names a Redis shared with a running dev
 * or staging API, this deletes that API's live budgets and standing blocks:
 * an abuse control silently disarmed by starting a test suite. The asymmetry
 * decides it — skipping the sweep costs a confusing local `429`, running it
 * unasked costs someone else's rate limiting.
 *
 * So an un-acknowledged external Redis keeps its buckets and says so. That
 * leaves the stale-state problem standing for exactly that configuration, which
 * is the trade: `BGE_E2E_REDIS_FLUSH_OK=true` is how a developer says the server
 * is theirs to sweep.
 *
 * `SCAN` rather than `KEYS`: the sweep runs against whatever server the
 * developer named, and `KEYS` on a large one blocks it.
 *
 * Returns the number of buckets removed; zero also covers "not authorised",
 * which is reported on the console rather than raised — a refusal here is a
 * safe outcome, not a broken run.
 */
export async function sweepThrottleBuckets(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!mayFlushRedis(env)) {
    console.warn(
      `[e2e] leaving rate-limit buckets on the Redis at ${E2E_REDIS_URL_VAR} alone — it may be shared with a ` +
        `running API, and sweeping would clear that API's live budgets and blocks. Set ` +
        `${E2E_REDIS_FLUSH_OK_VAR}=true if it is disposable. Until then a run inherits any throttle state left ` +
        `by the last one, which surfaces as 429s unrelated to the behaviour under test.`,
    );

    return 0;
  }

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
 *
 * TLS is read from the environment rather than assumed off. `BGE_E2E_REDIS_URL`
 * accepts `rediss://`, and `redisEnvOverrides` publishes that as
 * `REDIS_TLS_ENABLED=true`; a client that ignored it would offer plaintext to a
 * TLS port. Certificates are not read here because the overrides do not publish
 * any — the harness carries host, port, credentials and the TLS flag, and
 * nothing else.
 *
 * It gives up rather than reconnecting, which matters because the sweep runs
 * inside `globalSetup` before anything is listening to fail. A mismatched TLS
 * setting or a wrong port would otherwise leave iovalkey retrying forever and
 * hang the whole run until the job timeout, with nothing in the log to say why.
 * Five seconds and one attempt turns that into a readable error.
 *
 * `commandTimeout` covers the half `connectTimeout` does not. Once the socket
 * is up, a server that accepts the connection and then stops answering leaves
 * the `SCAN` below — and the `quit` after it — waiting on a reply with nothing
 * to time it out. `maxRetriesPerRequest` is not that bound either: it counts
 * RECONNECT attempts, and a connected-but-silent server never causes one. The
 * failure looks identical to a wrong port from outside, and lands in the same
 * place before any test has started, so it gets the same five seconds.
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
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    ...(env['REDIS_TLS_ENABLED'] === 'true' ? { tls: {} } : {}),
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
