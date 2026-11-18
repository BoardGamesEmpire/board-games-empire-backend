// The subpath, for the reason given in global-setup, which imports this file.
import { pollUntil } from '@bge/testing-e2e/poll';
import Redis from 'iovalkey';
import { GenericContainer, Wait } from 'testcontainers';
import { E2E_REDIS_SERVER_VAR } from './e2e-env';

/**
 * The Redis-compatible server the e2e suite runs against (#462).
 *
 * `BGE_E2E_REDIS_SERVER` names one of {@link REDIS_SERVERS}. Unset or blank, it
 * is `redis`, the one every pull request runs on. `global-setup` starts the
 * named one for the API, the worker and the specs, and the three specs that
 * start one of their own (`auth/auth-storage-atomic`, `bootstrap/cache-flush`
 * and `permissions/shared-graph-cache`) start the same, so what they show
 * holds for the Redis-compatible server the run names, not for stock Redis.
 *
 * Any other value is refused, with the list of names, rather than read as
 * `redis`: the run would pass on Redis and be reported as the one asked for. A
 * name together with `BGE_E2E_REDIS_URL` is refused too (see
 * `decideProvisioning`), because the URL sends the suite to a Redis-compatible
 * server the harness did not start, and nothing would check that it is the one
 * named.
 *
 * Why each setting:
 *
 * - The four non-default images are pinned, so a result names the version it
 *   ran on. KeyDB publishes version tags per architecture only, so its
 *   multi-architecture image (KeyDB 6.3.4) is pinned by digest. `redis` keeps
 *   the floating `redis:7-alpine` that every pull request has always run on.
 * - Redis, Valkey and KeyDB run their image's own command, with no password.
 *   For KeyDB that was probed (2026-11-16): its default config turns protected
 *   mode off and binds every interface, so the mapped port reaches it.
 * - Dragonfly refuses a Lua script that reaches a key it didn't declare, and
 *   BullMQ's scripts do. Each of two flag sets lets them run, and each is its
 *   own setup: `--default_lua_flags=allow-undeclared-keys` lets every script
 *   reach any key, and locks the whole store while one runs;
 *   `--cluster_mode=emulated --lock_on_hashtags` locks by hash tag instead,
 *   which is why every queue name carries one (`{bge.<area>.<name>}`).
 * - Both Dragonfly setups lift the limit on locked memory, as Dragonfly's
 *   Docker instructions ask.
 */

export type RedisServerName = 'redis' | 'valkey' | 'keydb' | 'dragonfly-undeclared-keys' | 'dragonfly-hashtags';

/** One Redis-compatible server a run may name: the image to start, and how. */
export interface RedisServerProfile {
  /** The arguments the container runs with; empty runs the image's own command. */
  readonly command: readonly string[];
  readonly image: string;

  /** Whether the container runs with no limit on locked memory. */
  readonly memlockUnlimited: boolean;

  readonly name: RedisServerName;
}

const DRAGONFLY_IMAGE = 'docker.dragonflydb.io/dragonflydb/dragonfly:v2.1.0';

/** Every Redis-compatible server a run may name, in the order the refusal lists them. */
export const REDIS_SERVERS: Readonly<Record<RedisServerName, RedisServerProfile>> = {
  redis: { name: 'redis', image: 'redis:7-alpine', command: [], memlockUnlimited: false },
  valkey: { name: 'valkey', image: 'valkey/valkey:9.0.3-alpine', command: [], memlockUnlimited: false },
  keydb: {
    name: 'keydb',
    image: 'eqalpha/keydb:latest@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac',
    command: [],
    memlockUnlimited: false,
  },
  'dragonfly-undeclared-keys': {
    name: 'dragonfly-undeclared-keys',
    image: DRAGONFLY_IMAGE,
    command: ['--default_lua_flags=allow-undeclared-keys'],
    memlockUnlimited: true,
  },
  'dragonfly-hashtags': {
    name: 'dragonfly-hashtags',
    image: DRAGONFLY_IMAGE,
    command: ['--cluster_mode=emulated', '--lock_on_hashtags'],
    memlockUnlimited: true,
  },
};

function isRedisServerName(value: string): value is RedisServerName {
  return Object.hasOwn(REDIS_SERVERS, value);
}

/**
 * The Redis-compatible server `BGE_E2E_REDIS_SERVER` names, or Redis when it
 * names none. Throws on any other value, listing the names, and never falls
 * back to Redis (#462).
 */
export function selectRedisServer(env: Readonly<Record<string, string | undefined>>): RedisServerProfile {
  const named = env[E2E_REDIS_SERVER_VAR]?.trim();

  if (!named) {
    return REDIS_SERVERS.redis;
  }

  if (!isRedisServerName(named)) {
    throw new Error(
      `${E2E_REDIS_SERVER_VAR} must be one of ${Object.keys(REDIS_SERVERS).join(', ')}; received '${named}'. ` +
        'Unset, it is redis.',
    );
  }

  return REDIS_SERVERS[named];
}

/** The port every profile serves on inside its container. */
const REDIS_PORT = 6379;

/** How long a started container has to answer PING. */
const PING_TIMEOUT_MS = 30_000;

/** How long one PING attempt may take to connect, and then to be answered. */
const PING_ATTEMPT_TIMEOUT_MS = 2_000;

/** A Redis-compatible server {@link startRedisServer} started, and the way to stop it. */
export interface StartedRedisServer {
  /** `redis://<host>:<port>`, with no credentials: no profile sets a password. */
  readonly connectionUrl: string;
  readonly host: string;
  readonly port: number;

  readonly profile: RedisServerProfile;

  stop(): Promise<void>;
}

/**
 * Whether `host:port` answers PING with PONG; `undefined` until it does, for
 * `pollUntil` to try again, since a rejected probe would end the poll at once.
 * One attempt per call, each bounded: the client neither retries nor
 * reconnects, so none is left reconnecting in the background, and a listener
 * that accepts the connection and then says nothing times out. The client's
 * ready check is off: while a server reports it is loading, that check repeats
 * INFO with no deadline, and `connect()` would never settle. PING answers a
 * loading server with an error instead, which is a "not yet" (#462).
 */
async function answersPing(host: string, port: number): Promise<true | undefined> {
  const client = new Redis({
    host,
    port,
    lazyConnect: true,
    connectTimeout: PING_ATTEMPT_TIMEOUT_MS,
    commandTimeout: PING_ATTEMPT_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableReadyCheck: false,
  });

  // A refused or reset connection is a "not yet", which the catch below
  // answers; without a listener, iovalkey would also log each one.
  client.on('error', () => undefined);

  try {
    await client.connect();

    return (await client.ping()) === 'PONG' ? true : undefined;
  } catch {
    return undefined;
  } finally {
    client.disconnect();
  }
}

/**
 * Starts the Redis-compatible server `profile` describes and waits until it
 * answers PING, so one that listens before it serves is not handed to the
 * suite early (#462). One that never answers is stopped, and the poll's
 * timeout, naming it, is the failure.
 */
export async function startRedisServer(profile: RedisServerProfile): Promise<StartedRedisServer> {
  const container = new GenericContainer(profile.image)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    // As long as `RedisContainer` allowed, which the harness used before.
    .withStartupTimeout(120_000);

  if (profile.command.length > 0) {
    container.withCommand([...profile.command]);
  }

  if (profile.memlockUnlimited) {
    container.withUlimits({ memlock: { hard: -1, soft: -1 } });
  }

  const started = await container.start();
  const host = started.getHost();
  const port = started.getMappedPort(REDIS_PORT);

  try {
    await pollUntil(() => answersPing(host, port), {
      description: `${profile.name} answers PING`,
      timeoutMs: PING_TIMEOUT_MS,
      intervalMs: 250,
    });
  } catch (error) {
    // A failed stop must not replace the PING timeout, which names the server.
    await started.stop().catch(() => undefined);
    throw error;
  }

  return {
    profile,
    host,
    port,
    connectionUrl: `redis://${host}:${port}`,
    stop: async () => {
      await started.stop();
    },
  };
}
