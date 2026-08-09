import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  apiEnvOverrides,
  decideProvisioning,
  E2E_BASE_URL_VAR,
  E2E_VERBOSE_VAR,
  parseRedisUrl,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  redisEnvOverrides,
  redisOwnershipOverride,
  type RedisEndpoint,
} from './e2e-env';
import { setE2EGlobalState } from './global-state';

/** apps/api-e2e/src/support → workspace root. */
const WORKSPACE_ROOT = path.join(__dirname, '..', '..', '..', '..');

/** The deployable artifact under test — built by the e2e target's `api:build` dependency. */
const API_BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'api', 'dist', 'main.js');

const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 250;
const OUTPUT_TAIL_LINES = 120;
const LAUNCH_ATTEMPTS = 3;

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

/**
 * Grabs an OS-assigned free port, then releases it for the API to bind.
 * Inherently racy (probe-then-bind): another process can claim the port in
 * the gap. `launchApi` compensates — an EADDRINUSE boot failure retries on
 * a fresh port instead of surfacing as a launch error.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to acquire a free port for the API'));
        return;
      }

      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface LaunchedApi {
  readonly child: ChildProcess;
  readonly baseUrl: string;
}

interface LaunchOutcome {
  readonly kind: 'ready' | 'port-collision' | 'failed';
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly failure?: string;
}

async function launchApiOnce(env: NodeJS.ProcessEnv, verbose: boolean): Promise<LaunchOutcome> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[e2e] launching API (${API_BUNDLE}) on ${baseUrl}...`);

  const child = spawn(process.execPath, [API_BUNDLE], {
    cwd: WORKSPACE_ROOT,
    env: { ...env, ...apiEnvOverrides(baseUrl, port) },
    // Always piped, never inherited: the retry path classifies a boot
    // failure by scanning this output for EADDRINUSE, and inherited stdio
    // would leave nothing to scan — making verbose runs the flaky ones.
    // Verbose mode tees each chunk through to the parent instead, so logs
    // still stream live.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outputTail: string[] = [];
  const capture = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
    if (verbose) {
      sink.write(chunk);
    }

    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length === 0) {
        continue;
      }

      outputTail.push(line);
      if (outputTail.length > OUTPUT_TAIL_LINES) {
        outputTail.shift();
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, process.stdout));
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, process.stderr));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const logsFor = (reason: string): string => {
    const logs = verbose ? '(logs were streamed above)' : `Last output:\n${outputTail.join('\n')}`;
    return `${reason}\n${logs}`;
  };

  /**
   * `getFreePort` is probe-then-bind, so another process can take the port
   * in the gap. That is retryable; every other boot death is not. Detection
   * scans the captured output because Node surfaces the child's bind error
   * only in its own stderr — the parent sees a plain non-zero exit.
   */
  const lostThePort = (): boolean => outputTail.some((line) => line.includes('EADDRINUSE'));

  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      return {
        kind: lostThePort() ? 'port-collision' : 'failed',
        child,
        baseUrl,
        failure: logsFor(`API process exited during boot (code ${String(child.exitCode)})`),
      };
    }

    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) {
        break;
      }
    } catch {
      // Not listening yet — keep polling.
    }

    if (Date.now() >= deadline) {
      child.kill('SIGKILL');
      return {
        kind: 'failed',
        child,
        baseUrl,
        failure: logsFor(`API did not become ready within ${READINESS_TIMEOUT_MS}ms`),
      };
    }

    await delay(READINESS_POLL_MS);
  }

  return { kind: 'ready', child, baseUrl };
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
 * debug without its logs. An EADDRINUSE boot failure — the getFreePort
 * race lost — retries on a fresh port up to LAUNCH_ATTEMPTS.
 */
async function launchApi(env: NodeJS.ProcessEnv): Promise<LaunchedApi> {
  if (!fs.existsSync(API_BUNDLE)) {
    throw new Error(
      `API bundle not found at ${API_BUNDLE}. The e2e target depends on '@boardgamesempire/api:build' — ` +
        `run via 'npx nx e2e @boardgamesempire/api-e2e' (or build the api first).`,
    );
  }

  const verbose = env[E2E_VERBOSE_VAR] === 'true';

  for (let attempt = 1; ; attempt += 1) {
    const outcome = await launchApiOnce(env, verbose);

    if (outcome.kind === 'ready') {
      return { child: outcome.child, baseUrl: outcome.baseUrl };
    }

    if (outcome.kind === 'port-collision' && attempt < LAUNCH_ATTEMPTS) {
      console.warn(`[e2e] port collision on launch attempt ${attempt}/${LAUNCH_ATTEMPTS}, retrying on a fresh port...`);
      continue;
    }

    throw new Error(outcome.failure ?? 'API launch failed');
  }
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
 *     seed hook (`prisma/seed.ts` → `runSeeds`).
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
        '[e2e] using external Redis from BGE_E2E_REDIS_URL — set BGE_E2E_REDIS_FLUSH_OK=true to allow resetRedis (FLUSHALL)',
      );
    }

    process.env['DATABASE_URL'] = databaseUrl;
    // Ownership is assigned unconditionally alongside the connection
    // details, not inside the branch above: a branch that sets the flag
    // only on one path leaves an inherited value standing on the other,
    // and for this flag that means authorizing FLUSHALL on a Redis the
    // harness did not provision.
    Object.assign(process.env, redisEnvOverrides(redisEndpoint), redisOwnershipOverride(decision.redis.mode));

    runPrisma(['migrate', 'deploy'], databaseUrl);
    runPrisma(['db', 'seed'], databaseUrl);

    const launched = await launchApi(process.env);
    api = launched.child;
    process.env[E2E_BASE_URL_VAR] = launched.baseUrl;

    // Best-effort orphan guard: covers every exit path of THIS process
    // (including unhandled throws). No-ops after a clean teardown, since the
    // child has already exited by then.
    const apiChild = api;
    process.once('exit', () => {
      if (apiChild.exitCode === null && apiChild.signalCode === null) {
        apiChild.kill('SIGKILL');
      }
    });

    setE2EGlobalState({ postgres, redis, api });
    console.log(`[e2e] harness ready — API at ${launched.baseUrl}`);
  } catch (error) {
    // Teardown never runs when setup throws — stop whatever already started.
    api?.kill('SIGKILL');
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    throw error;
  }
}
