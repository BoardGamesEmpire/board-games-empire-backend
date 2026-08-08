/**
 * Pure environment-resolution logic for the e2e harness (#255). Everything
 * here is side-effect free so it can be unit-tested without Docker; the
 * side-effectful application of these decisions lives in `global-setup.ts`.
 *
 * `.env` is gitignored and developer-owned (copied from `.env.example` and
 * locally modified), so the harness NEVER writes to it. Instead,
 * `global-setup` assigns the ephemeral connection details to `process.env`
 * before Jest spawns its workers — `@nestjs/config` and dotenv both treat
 * pre-existing process env as authoritative over `.env` values, so the
 * overrides below win without touching the file.
 */

/** Escape hatch: point the suite at an existing Postgres instead of a container. */
export const E2E_DATABASE_URL_VAR = 'BGE_E2E_DATABASE_URL';

/** Escape hatch: point the suite at an existing Redis instead of a container. */
export const E2E_REDIS_URL_VAR = 'BGE_E2E_REDIS_URL';

/**
 * Whether the harness provisioned the Redis server itself. Published by
 * `global-setup` for BOTH provisioning modes (see
 * {@link redisOwnershipOverride}) — never merely left alone — because
 * destructive helpers (`resetRedis`) gate on it.
 */
export const E2E_OWNS_REDIS_VAR = 'BGE_E2E_OWNS_REDIS';

/**
 * Explicit opt-in acknowledging that the external Redis named by
 * {@link E2E_REDIS_URL_VAR} is disposable and may be FLUSHALLed.
 */
export const E2E_REDIS_FLUSH_OK_VAR = 'BGE_E2E_REDIS_FLUSH_OK';

/** Set truthy to route application logs through nestjs-pino during e2e runs. */
export const E2E_VERBOSE_VAR = 'BGE_E2E_VERBOSE';

/**
 * Where the harness-launched API is listening. Assigned by `global-setup`
 * after the server process passes its readiness probe; specs read it back
 * through {@link requireBaseUrl}. The suite is black-box: everything a spec
 * asserts about application behavior travels over this URL.
 */
export const E2E_BASE_URL_VAR = 'BGE_E2E_BASE_URL';

/**
 * The variable the API's `system` config reads its listen port from (see
 * `apps/api/src/app/configuration/system.config.ts`). Named here rather than
 * inlined because getting it wrong is invisible: the server boots happily on
 * its 33333 default and the readiness probe just times out.
 */
export const API_PORT_VAR = 'SERVER_PORT';

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';

/**
 * The three logical Redis connections the API configures via
 * `makeRedisConfig` (see `apps/api/src/app/configuration`). The harness
 * points all three at the same ephemeral server; the per-connection
 * database indices from the config defaults keep them logically separate.
 */
export const REDIS_ENV_PREFIXES = ['REDIS_', 'REDIS_WEBSOCKET_', 'REDIS_BULLMQ_'] as const;
export type RedisEnvPrefix = (typeof REDIS_ENV_PREFIXES)[number];

/**
 * The logical database index each connection uses, mirroring the `database`
 * option each config passes to `makeRedisConfig` (redis.config.ts: 0,
 * redis-sockets.config.ts: 1, redis-queue.config.ts: 2). Pinned in the
 * overrides so a developer's `.env` (e.g. `REDIS_BULLMQ_DATABASE=5`) cannot
 * send the API to one logical database while the test-side queue helpers
 * inspect another.
 */
export const REDIS_ENV_DATABASES: Readonly<Record<RedisEnvPrefix, number>> = {
  REDIS_: 0,
  REDIS_WEBSOCKET_: 1,
  REDIS_BULLMQ_: 2,
};

export interface ContainerProvisioning {
  readonly mode: 'container';
}

export interface ExternalProvisioning {
  readonly mode: 'external';
  readonly url: string;
}

export type Provisioning = ContainerProvisioning | ExternalProvisioning;

export interface ProvisioningDecision {
  readonly database: Provisioning;
  readonly redis: Provisioning;
}

/**
 * Decides, from an environment snapshot, whether each dependency comes from
 * a testcontainer (the default) or an externally supplied endpoint (the
 * escape hatch). External endpoints are treated as DISPOSABLE: migrations,
 * seeds, and the truncate sweep all run against them.
 */
export function decideProvisioning(env: Readonly<Record<string, string | undefined>>): ProvisioningDecision {
  const databaseUrl = env[E2E_DATABASE_URL_VAR]?.trim();
  const redisUrl = env[E2E_REDIS_URL_VAR]?.trim();

  return {
    database: databaseUrl ? { mode: 'external', url: databaseUrl } : { mode: 'container' },
    redis: redisUrl ? { mode: 'external', url: redisUrl } : { mode: 'container' },
  };
}

export interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly tls: boolean;
}

/**
 * Percent-decodes one userinfo component. WHATWG `URL` does NOT decode
 * `username`/`password` — it hands them back still encoded — so decoding
 * here is required: a password containing `@` must be written `%40` (an
 * unescaped `@` would terminate the userinfo), and forwarding the literal
 * `%40` to Redis would fail AUTH.
 *
 * A lone `%` that is not a valid escape makes `decodeURIComponent` throw
 * `URI malformed`, which names neither the variable nor the fix; this
 * rethrows something actionable.
 */
function decodeUserInfo(raw: string, component: 'username' | 'password'): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(
      `${E2E_REDIS_URL_VAR} has a malformed percent-escape in its ${component}. ` +
        `Userinfo is percent-encoded: write a literal '%' as '%25' (and '@' as '%40').`,
    );
  }
}

/**
 * Parses a `redis://` or `rediss://` URL into the pieces `makeRedisConfig`
 * consumes via environment variables. Throws on any other protocol —
 * a silently misread URL would send the suite at the wrong server.
 */
export function parseRedisUrl(raw: string): RedisEndpoint {
  const url = new URL(raw);

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`${E2E_REDIS_URL_VAR} must be a redis:// or rediss:// URL; received protocol '${url.protocol}'`);
  }

  if (url.pathname !== '' && url.pathname !== '/') {
    // A database index in the URL is ambiguous here: the harness drives
    // THREE logical databases (REDIS_ENV_DATABASES), so honoring a single
    // index would silently collapse them onto one.
    throw new Error(
      `${E2E_REDIS_URL_VAR} must not carry a database index ('${url.pathname}') — ` +
        `the harness assigns per-connection databases itself (see REDIS_ENV_DATABASES).`,
    );
  }

  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    username: decodeUserInfo(url.username, 'username'),
    password: decodeUserInfo(url.password, 'password'),
    tls: url.protocol === 'rediss:',
  };
}

/**
 * Builds the full set of Redis environment overrides for one endpoint,
 * covering every prefix in {@link REDIS_ENV_PREFIXES}. Host, port,
 * credentials, and the TLS flag are all overridden so a developer's `.env`
 * (which may point at a passworded or TLS-enabled dev server) can never
 * leak into the ephemeral connection. `makeRedisConfig` maps an empty
 * password to "send no AUTH", which matches a fresh container.
 */
export function redisEnvOverrides(endpoint: RedisEndpoint): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (const prefix of REDIS_ENV_PREFIXES) {
    overrides[`${prefix}HOST`] = endpoint.host;
    overrides[`${prefix}PORT`] = String(endpoint.port);
    overrides[`${prefix}DATABASE`] = String(REDIS_ENV_DATABASES[prefix]);
    overrides[`${prefix}USERNAME`] = endpoint.username;
    overrides[`${prefix}PASSWORD`] = endpoint.password;
    overrides[`${prefix}TLS_ENABLED`] = endpoint.tls ? 'true' : 'false';
  }

  return overrides;
}

/**
 * Records whether the harness provisioned Redis itself, as the env var the
 * destructive helpers gate on. Returns the flag for BOTH modes — the
 * external path must publish `'false'` rather than leaving the variable
 * alone, because an inherited value (exported in a shell, left in `.env`,
 * or set by an earlier container-mode run in the same process) would
 * otherwise still read as `'true'` and authorize FLUSHALL against a Redis
 * the harness does not own. The harness is the only writer; whatever was
 * in the environment before is not evidence of anything.
 */
export function redisOwnershipOverride(mode: Provisioning['mode']): Record<string, string> {
  return { [E2E_OWNS_REDIS_VAR]: mode === 'container' ? 'true' : 'false' };
}

/** The launched API's base URL, or a loud failure if globalSetup never ran. */
export function requireBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const baseUrl = env[E2E_BASE_URL_VAR]?.trim();

  if (!baseUrl) {
    throw new Error(`${E2E_BASE_URL_VAR} is not set — did the e2e globalSetup run (and pass its readiness probe)?`);
  }

  return baseUrl;
}

/**
 * The schema a `DATABASE_URL` targets: its `?schema=` search param, or
 * Prisma's `public` default. The truncate sweep scopes its `pg_tables`
 * discovery to exactly this schema — the escape-hatch database may host
 * other schemas that are none of the harness's business.
 */
export function schemaFromDatabaseUrl(databaseUrl: string): string {
  return new URL(databaseUrl).searchParams.get('schema') ?? 'public';
}
