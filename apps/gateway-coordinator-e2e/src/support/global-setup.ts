// The subpath, not the package root: Jest loads global setup and teardown
// with Node's resolver, which cannot follow the root's `.js` specifiers to
// their `.ts` sources.
import { WORKSPACE_ROOT } from '@bge/testing-e2e/child-process';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { spawnSync } from 'node:child_process';
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { POSTGRES_IMAGE, REDIS_IMAGE, redisEnvOverrides } from './e2e-env';
import { setE2EGlobalState } from './global-state';

const REDIS_PORT = 6379;

/**
 * Starts stock Redis as a plain container. The workspace dropped
 * `@testcontainers/redis` when `apps/api-e2e` moved to its own server
 * profiles (#462); this is all the coordinator's suite used from it: the
 * port, and the log line that says Redis accepts connections.
 */
function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
}

/**
 * Runs the Prisma CLI against the harness's database, as `apps/api-e2e` does:
 * the CLI is the supported way to migrate and seed in Prisma 7, and it
 * prefers `DATABASE_MIGRATION_URL`, so both variables name that database.
 */
function runPrisma(args: readonly string[], databaseUrl: string): void {
  const display = `npx prisma ${args.join(' ')}`;
  console.log(`[e2e] ${display}`);

  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_MIGRATION_URL: databaseUrl },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`'${display}' exited with status ${String(result.status)}`);
  }
}

/**
 * Provisions what the coordinator needs, once per Jest run (#1083):
 *
 *  1. Postgres and Redis testcontainers.
 *  2. `process.env` overrides for the database and for both of the
 *     coordinator's Redis connections. Jest starts its workers after this
 *     resolves, so the spec files inherit them, and each hands them to the
 *     coordinator it launches. `.env` is never written.
 *  3. `prisma migrate deploy`, then `prisma db seed`: the coordinator applies
 *     no migration, and waits at boot for a schema that matches its build.
 *
 * No server is launched here. Each spec file launches its own coordinator
 * (`coordinator.ts`), since what a coordinator loads is decided by the plugin
 * rows and the plugins root it finds when it boots.
 *
 * If the process dies without teardown, testcontainers' reaper removes the
 * containers after its timeout.
 */
export default async function globalSetup(): Promise<void> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedTestContainer | undefined;

  try {
    console.log(`[e2e] starting ${POSTGRES_IMAGE} (testcontainers)...`);
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    const databaseUrl = postgres.getConnectionUri();

    console.log(`[e2e] starting ${REDIS_IMAGE} (testcontainers)...`);
    redis = await startRedis();

    process.env['DATABASE_URL'] = databaseUrl;
    // The migration credential too, to the same database: a developer's `.env`
    // may set one for their own database, and Nx loads `.env` into this
    // process.
    process.env['DATABASE_MIGRATION_URL'] = databaseUrl;
    Object.assign(process.env, redisEnvOverrides(redis.getHost(), redis.getMappedPort(REDIS_PORT)));

    runPrisma(['migrate', 'deploy'], databaseUrl);
    runPrisma(['db', 'seed'], databaseUrl);

    setE2EGlobalState({ postgres, redis });
    console.log('[e2e] harness ready: Postgres and Redis are up, migrated and seeded');
  } catch (error) {
    // Teardown never runs when setup throws, so stop whatever already started.
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    throw error;
  }
}
