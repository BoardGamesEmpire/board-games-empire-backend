// The subpath, not the package root: Jest loads global setup and teardown
// with Node's resolver, which cannot follow the root's `.js` specifiers to
// their `.ts` sources.
import {
  E2E_VERBOSE_VAR,
  getFreePort,
  killOnExit,
  launchOnFreePort,
  requireBundle,
  WORKSPACE_ROOT,
} from '@bge/testing-e2e/child-process';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RedisEndpoint } from './e2e-env';
import {
  apiEnvOverrides,
  decideProvisioning,
  E2E_BASE_URL_VAR,
  E2E_DATABASE_CONTAINER_ADDRESS_VAR,
  E2E_FAKE_PROVIDER_URL_VAR,
  E2E_MAILPIT_VAR,
  E2E_OPERATIONAL_URL_VAR,
  E2E_PLUGINS_ROOT_VAR,
  fakeProviderEnv,
  MAILPIT_IMAGE,
  parseRedisUrl,
  POSTGRES_IMAGE,
  redisEnvOverrides,
  redisOwnershipOverride,
} from './e2e-env';
import type { FakeSignInProvider } from './fake-sign-in-provider';
import { startFakeSignInProvider } from './fake-sign-in-provider';
import { setE2EGlobalState } from './global-state';
import type { StartedMailpit } from './mailpit';
import { startMailpit } from './mailpit';
import { sweepThrottleBuckets } from './redis-reset';
import type { StartedRedisServer } from './redis-server';
import { selectRedisServer, startRedisServer } from './redis-server';

/** The deployable artifact under test — built by the e2e target's `api:build` dependency. */
const API_BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'api', 'dist', 'main.js');

/** The port Postgres listens on inside its container; the testcontainers module does not export it. */
const POSTGRES_PORT = 5432;

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 250;

/**
 * Runs the Prisma CLI as a child process with `DATABASE_URL` and
 * `DATABASE_MIGRATION_URL` overridden to the ephemeral database; the CLI
 * prefers the second. The CLI is the honest programmatic surface for
 * migrations in Prisma 7 (no supported in-process API); #236's bootstrap
 * orchestration is expected to converge on the same invocation rather than
 * growing a parallel path.
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

interface LaunchedApi {
  readonly baseUrl: string;
  readonly child: ChildProcess;

  /** Where the same server answers its operational routes (#1511). */
  readonly operationalUrl: string;
}

const apiBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** Whether `url` answers 200 yet; a refused connection is "not yet", not a failure. */
async function answersOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.status === 200;
  } catch {
    // Not listening yet — keep polling.
    return false;
  }
}

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
 *
 * The API binds a second port, for its operational routes (#1511). It takes a
 * fresh one on each attempt, never the public port, which the API would refuse
 * at boot. Readiness waits for that port too: the API listens on it just after
 * the public one, so a probe of the public port alone could pass first.
 */
async function launchApi(env: NodeJS.ProcessEnv, pluginsRoot: string): Promise<LaunchedApi> {
  requireBundle('API', API_BUNDLE, '@boardgamesempire/api:build');

  const verbose = env[E2E_VERBOSE_VAR] === 'true';
  let operationalPort = 0;

  const { child, port } = await launchOnFreePort(async (port) => {
    do {
      operationalPort = await getFreePort();
    } while (operationalPort === port);

    const baseUrl = apiBaseUrl(port);
    const operationalUrl = apiBaseUrl(operationalPort);
    console.log(`[e2e] launching API (${API_BUNDLE}) on ${baseUrl}, operational routes on ${operationalUrl}...`);

    return {
      label: 'API',
      bundle: API_BUNDLE,
      env: { ...env, ...apiEnvOverrides(baseUrl, port, operationalPort, pluginsRoot) },
      verbose,
      isReady: async () =>
        (await answersOk(`${baseUrl}/health/ready`)) && (await answersOk(`${operationalUrl}/health/live`)),
      timeoutMs: READINESS_TIMEOUT_MS,
      pollMs: READINESS_POLL_MS,
    };
  });

  return { child, baseUrl: apiBaseUrl(port), operationalUrl: apiBaseUrl(operationalPort) };
}

/**
 * Provisions the suite's dependencies once per Jest run:
 *
 *  1. Postgres and Redis testcontainers (or the `BGE_E2E_*` escape-hatch
 *     endpoints — treated as DISPOSABLE: they are migrated, seeded, and
 *     swept exactly like a container). The Redis container is the
 *     Redis-compatible server `BGE_E2E_REDIS_SERVER` names, stock Redis
 *     when it names none (#462).
 *  2. A Mailpit container, the SMTP server outgoing mail reaches (#654); its
 *     ports are published via `BGE_E2E_MAILPIT`. Always a container, with no
 *     escape hatch: nothing reaches it until a spec points the mail settings
 *     at it, and a spec reads back every message it holds.
 *  3. `process.env` overrides for `DATABASE_URL`, `DATABASE_MIGRATION_URL`,
 *     the address other containers reach the Postgres container at, and all
 *     three Redis connection prefixes. Jest spawns its workers AFTER globalSetup
 *     resolves, so the workers inherit these values; the API child process
 *     receives them explicitly. `.env` (gitignored, developer-owned) is
 *     never written, and dotenv semantics mean it never overrides an
 *     already-set process variable.
 *  4. `prisma migrate deploy` — the real migration chain, from empty,
 *     is itself under test.
 *  5. `prisma db seed` — the real reference seeds via the `prisma.config.ts`
 *     seed hook (`libs/database/src/seed-cli.ts` → `runSeeds`).
 *  6. A fake sign-in provider in this process, listed to the API as its only
 *     sign-in provider (#912); its URL is published via
 *     `BGE_E2E_FAKE_PROVIDER_URL`.
 *  7. A fresh plugins root for the API, published via `BGE_E2E_PLUGINS_ROOT`
 *     and removed by teardown (#1094).
 *  8. The built API bundle as a child process, gated on `/health/ready`
 *     and on its operational port answering; its base URL is published via
 *     `BGE_E2E_BASE_URL`, and its operational URL via
 *     `BGE_E2E_OPERATIONAL_URL` (#1511).
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
  // The Redis-compatible server `BGE_E2E_REDIS_SERVER` names, Redis when it
  // names none (#462); the spec-owned containers start the same one. Chosen
  // before anything starts, so a misspelled name fails at once.
  const redisProfile = selectRedisServer(process.env);

  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisServer | undefined;
  let mailpit: StartedMailpit | undefined;
  let api: ChildProcess | undefined;
  let signInProvider: FakeSignInProvider | undefined;
  let pluginsRoot: string | undefined;

  try {
    let databaseUrl: string;
    if (decision.database.mode === 'container') {
      console.log(`[e2e] starting ${POSTGRES_IMAGE} (testcontainers)...`);
      postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
      databaseUrl = postgres.getConnectionUri();
      // Container to container, over the network both join by default.
      process.env[E2E_DATABASE_CONTAINER_ADDRESS_VAR] =
        `${postgres.getIpAddress(postgres.getNetworkNames()[0])}:${POSTGRES_PORT}`;
    } else {
      databaseUrl = decision.database.url;
      console.warn(
        '[e2e] using external database from BGE_E2E_DATABASE_URL — it will be migrated, seeded, and truncated (DISPOSABLE)',
      );
    }

    let redisEndpoint: RedisEndpoint;
    if (decision.redis.mode === 'container') {
      console.log(`[e2e] starting ${redisProfile.image} as ${redisProfile.name} (testcontainers)...`);
      redis = await startRedisServer(redisProfile);
      redisEndpoint = {
        host: redis.host,
        port: redis.port,
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

    // After Redis and before the API, though neither child reads it: the API
    // and the worker learn the SMTP server only from the mail settings on the
    // settings row, which a spec points here (#654).
    console.log(`[e2e] starting ${MAILPIT_IMAGE} (testcontainers)...`);
    mailpit = await startMailpit();
    process.env[E2E_MAILPIT_VAR] = JSON.stringify({
      smtpHost: mailpit.smtpHost,
      smtpPort: mailpit.smtpPort,
      apiUrl: mailpit.apiUrl,
    });

    process.env['DATABASE_URL'] = databaseUrl;
    // The migration credential too, to the same database: a developer's `.env`
    // may set one for their own database, and Nx loads `.env` into this
    // process. Unset or empty, the children would read it from there (Nest's
    // variable expansion treats '' as unset), and migrate that database.
    process.env['DATABASE_MIGRATION_URL'] = databaseUrl;
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

    // Before the API, which reads its sign-in providers once, at boot.
    signInProvider = await startFakeSignInProvider();
    Object.assign(process.env, fakeProviderEnv(signInProvider.url));
    process.env[E2E_FAKE_PROVIDER_URL_VAR] = signInProvider.url;

    // A fresh plugins root for the API (#1094), which the install ingress
    // fills; specs read where it is from the variable.
    pluginsRoot = await mkdtemp(path.join(tmpdir(), 'bge-e2e-plugins-'));
    process.env[E2E_PLUGINS_ROOT_VAR] = pluginsRoot;

    const launched = await launchApi(process.env, pluginsRoot);
    api = launched.child;
    process.env[E2E_BASE_URL_VAR] = launched.baseUrl;
    process.env[E2E_OPERATIONAL_URL_VAR] = launched.operationalUrl;

    // Covers every exit path of THIS process, including unhandled throws; a
    // no-op after a clean teardown, since the child has exited by then.
    killOnExit(api);

    setE2EGlobalState({ postgres, redis, mailpit, api, signInProvider, pluginsRoot });
    console.log(`[e2e] harness ready — API at ${launched.baseUrl}, operational routes at ${launched.operationalUrl}`);
  } catch (error) {
    // Teardown never runs when setup throws — stop whatever already started.
    api?.kill('SIGKILL');
    await Promise.allSettled([
      signInProvider?.close(),
      postgres?.stop(),
      redis?.stop(),
      mailpit?.stop(),
      pluginsRoot === undefined ? undefined : rm(pluginsRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}
