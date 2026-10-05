// The subpath, not the package root: Jest loads global setup and teardown
// with Node's resolver, which cannot follow the root's `.js` specifiers to
// their `.ts` sources.
import {
  E2E_VERBOSE_VAR,
  killOnExit,
  launchOnFreePort,
  requireBundle,
  WORKSPACE_ROOT,
} from '@bge/testing-e2e/child-process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { spawnSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import {
  apiEnvOverrides,
  decideProvisioning,
  E2E_BASE_URL_VAR,
  parseRedisUrl,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  redisEnvOverrides,
  redisOwnershipOverride,
  type RedisEndpoint,
} from './e2e-env';
import { setE2EGlobalState } from './global-state';
import { sweepThrottleBuckets } from './redis-reset';

/** The deployable artifact under test — built by the e2e target's `api:build` dependency. */
const API_BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'api', 'dist', 'main.js');

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 250;

/**
 * Runs the Prisma CLI as a child process with `DATABASE_URL` overridden to
 * the ephemeral database. The CLI is the honest programmatic surface for
 * migrations in Prisma 7 (no supported in-process API); #236's bootstrap
 * orchestration is expected to converge on the same invocation rather than
 * growing a parallel path.
 */
function runPrisma(args: readonly string[], databaseUrl: string): void {
  const display = `npx prisma ${args.join(' ')}`;
  console.log(`[e2e] ${display}`);

  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
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

interface LaunchedApi {
  readonly child: ChildProcess;
  readonly baseUrl: string;
}

const apiBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * Launches the built API bundle as a real child process — the same
 * `node apps/api/dist/main.js` the `serve` target and the Docker image run —
 * and gates on `/health/ready` so the suite only starts once Postgres and
 * Redis are actually wired. The suite is black-box: the test process never
 * imports application code, it only speaks HTTP to this server.
 *
 * Output is captured and replayed on failure (or streamed live with
 * `BGE_E2E_VERBOSE`), because a server that dies during boot is useless to
 * debug without its logs. A port lost before the API could bind it is
 * retried on a fresh one (`launchOnFreePort`).
 */
async function launchApi(env: NodeJS.ProcessEnv): Promise<LaunchedApi> {
  requireBundle('API', API_BUNDLE, '@boardgamesempire/api:build');

  const verbose = env[E2E_VERBOSE_VAR] === 'true';

  const { child, port } = await launchOnFreePort((port) => {
    const baseUrl = apiBaseUrl(port);
    console.log(`[e2e] launching API (${API_BUNDLE}) on ${baseUrl}...`);

    return {
      label: 'API',
      bundle: API_BUNDLE,
      env: { ...env, ...apiEnvOverrides(baseUrl, port) },
      verbose,
      isReady: async () => {
        try {
          const response = await fetch(`${baseUrl}/health/ready`);
          return response.status === 200;
        } catch {
          // Not listening yet — keep polling.
          return false;
        }
      },
      timeoutMs: READINESS_TIMEOUT_MS,
      pollMs: READINESS_POLL_MS,
    };
  });

  return { child, baseUrl: apiBaseUrl(port) };
}

/**
 * Provisions the suite's dependencies once per Jest run:
 *
 *  1. Postgres and Redis testcontainers (or the `BGE_E2E_*` escape-hatch
 *     endpoints — treated as DISPOSABLE: they are migrated, seeded, and
 *     swept exactly like a container).
 *  2. `process.env` overrides for `DATABASE_URL` and all three Redis
 *     connection prefixes. Jest spawns its workers AFTER globalSetup
 *     resolves, so the workers inherit these values; the API child process
 *     receives them explicitly. `.env` (gitignored, developer-owned) is
 *     never written, and dotenv semantics mean it never overrides an
 *     already-set process variable.
 *  3. `prisma migrate deploy` — the real migration chain, from empty,
 *     is itself under test.
 *  4. `prisma db seed` — the real reference seeds via the `prisma.config.ts`
 *     seed hook (`libs/database/src/seed-cli.ts` → `runSeeds`).
 *  5. The built API bundle as a child process, gated on `/health/ready`;
 *     its base URL is published via `BGE_E2E_BASE_URL`.
 *
 * Handles are stashed on `globalThis` for `global-teardown`. If the process
 * dies without teardown, testcontainers' reaper (ryuk) removes the
 * containers after its timeout. The API child shares the runner's process
 * group (Ctrl-C reaches it) and a best-effort `process.on('exit')` hook
 * kills it on any normal or thrown exit — but a SIGKILLed runner can still
 * orphan it; there is no portable parent-death signal to close that hole.
 */
export default async function globalSetup(): Promise<void> {
  const decision = decideProvisioning(process.env);

  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  let api: ChildProcess | undefined;

  try {
    let databaseUrl: string;
    if (decision.database.mode === 'container') {
      console.log(`[e2e] starting ${POSTGRES_IMAGE} (testcontainers)...`);
      postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
      databaseUrl = postgres.getConnectionUri();
    } else {
      databaseUrl = decision.database.url;
      console.warn(
        '[e2e] using external database from BGE_E2E_DATABASE_URL — it will be migrated, seeded, and truncated (DISPOSABLE)',
      );
    }

    let redisEndpoint: RedisEndpoint;
    if (decision.redis.mode === 'container') {
      console.log(`[e2e] starting ${REDIS_IMAGE} (testcontainers)...`);
      redis = await new RedisContainer(REDIS_IMAGE).start();
      redisEndpoint = {
        host: redis.getHost(),
        port: redis.getPort(),
        username: '',
        password: '',
        tls: false,
      };
    } else {
      redisEndpoint = parseRedisUrl(decision.redis.url);
      console.warn(
        '[e2e] using external Redis from BGE_E2E_REDIS_URL — unless BGE_E2E_REDIS_FLUSH_OK=true marks it disposable, ' +
          'the rate-limit sweep is skipped and specs that isolate a queue or start a worker refuse to run',
      );
    }

    process.env['DATABASE_URL'] = databaseUrl;
    // Ownership is assigned unconditionally alongside the connection
    // details, not inside the branch above: a branch that sets the flag
    // only on one path leaves an inherited value standing on the other,
    // and for this flag that means authorizing queue obliteration and a
    // worker on a Redis the harness did not provision.
    Object.assign(process.env, redisEnvOverrides(redisEndpoint), redisOwnershipOverride(decision.redis.mode));

    // Rate-limit buckets outlive the API child now that they live in Redis
    // (#341), so on a reused server a run inherits the last one's counters —
    // and any block still standing. Runs after the ownership flag is published
    // above, because the sweep gates on it: against the throwaway container it
    // is authorised and finds nothing, and against an external Redis nobody has
    // called disposable it declines and says why.
    const sweptBuckets = await sweepThrottleBuckets(process.env);
    if (sweptBuckets > 0) {
      console.warn(`[e2e] cleared ${sweptBuckets} rate-limit bucket(s) left on this Redis by an earlier run`);
    }

    runPrisma(['migrate', 'deploy'], databaseUrl);
    runPrisma(['db', 'seed'], databaseUrl);

    const launched = await launchApi(process.env);
    api = launched.child;
    process.env[E2E_BASE_URL_VAR] = launched.baseUrl;

    // Covers every exit path of THIS process, including unhandled throws; a
    // no-op after a clean teardown, since the child has exited by then.
    killOnExit(api);

    setE2EGlobalState({ postgres, redis, api });
    console.log(`[e2e] harness ready — API at ${launched.baseUrl}`);
  } catch (error) {
    // Teardown never runs when setup throws — stop whatever already started.
    api?.kill('SIGKILL');
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    throw error;
  }
}
