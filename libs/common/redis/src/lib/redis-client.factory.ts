import Redis, { type RedisOptions } from 'iovalkey';
import type { BgeRedisConnectionConfig } from './redis-connection.config';

const DEFAULT_KEEP_ALIVE_MS = 30_000;

/**
 * Converts a `BgeRedisConnectionConfig` into an ioredis-compatible options
 * object (consumed by iovalkey, which is a Valkey-focused fork of ioredis
 * with the same options shape).
 *
 * The BGE shape (nested `socket` with separate TLS toggle and certs) maps onto
 * the flat option structure. Falsy strings for username/password are
 * normalized to `undefined` so the client treats them as "not set" rather than
 * authenticating as an empty user.
 *
 * Per-connection overrides (e.g. `maxRetriesPerRequest: null` for BullMQ
 * producers) win over defaults.
 */
export function toIoRedisOptions(
  config: BgeRedisConnectionConfig,
  overrides: Partial<RedisOptions> = {},
): RedisOptions {
  const base: RedisOptions = {
    host: config.socket.host,
    port: config.socket.port,
    db: config.database,
    username: config.username || undefined,
    password: config.password || undefined,
    tls: config.socket.tls
      ? {
          ca: config.socket.ca || undefined,
          key: config.socket.key || undefined,
          cert: config.socket.cert || undefined,
          rejectUnauthorized: config.socket.rejectUnauthorized,
        }
      : undefined,
    keepAlive: DEFAULT_KEEP_ALIVE_MS,
    enableReadyCheck: true,
    // Connection name aids server-side identification in CLIENT LIST output.
    connectionName: 'bge',
  };

  return { ...base, ...overrides };
}

/**
 * Constructs an iovalkey client from a BGE connection config.
 *
 * Centralizing construction here serves two purposes: it keeps the rest of
 * the lib free of direct `iovalkey` imports, and it gives tests a single
 * mockable seam. The module spec mocks this factory rather than the
 * `iovalkey` package itself — package-level mocking is unreliable under
 * SWC/jest interop for default-exported CJS modules.
 */
export function createRedisClient(config: BgeRedisConnectionConfig, overrides: Partial<RedisOptions> = {}): Redis {
  return new Redis(toIoRedisOptions(config, overrides));
}
