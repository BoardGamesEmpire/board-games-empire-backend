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

  const host = env['REDIS_HOST'];
  const port = Number(env['REDIS_PORT']);

  if (!host || !Number.isFinite(port)) {
    throw new Error('REDIS_HOST/PORT are not set — did the e2e globalSetup run?');
  }

  const client = new Redis({
    host,
    port,
    username: env['REDIS_USERNAME'] || undefined,
    password: env['REDIS_PASSWORD'] || undefined,
  });

  try {
    await client.flushall();
  } finally {
    await client.quit();
  }
}
