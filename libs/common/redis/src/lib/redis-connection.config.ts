import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

/**
 * Shared Redis connection configuration shape used by all BGE Redis
 * configurations (cache, queue, websocket).
 *
 * Mirrors the structure used by `@keyv/redis` and `@keyv/valkey` connection
 * options so the same config object can drive both a Keyv-backed cache store
 * and a raw ioredis client.
 */
export interface BgeRedisConnectionConfig {
  username?: string;
  password?: string;
  database?: number;
  socket: {
    host: string;
    port: number;
    tls: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
    key?: string;
    cert?: string;
  };
}

/**
 * Async resolver for a single connection.
 *
 * Each connection in `RedisModule.forRootAsync` is configured independently
 * with its own `inject`/`useFactory` pair. This allows a single deployment
 * to source different connections from different config providers, and lets
 * a process configure only the connections it needs (e.g. a worker that
 * needs only the queue connection).
 */
export interface BgeRedisAsyncConnectionOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];

  // NestJS DI factories are inherently variadic; `any[]` here matches the
  // codebase convention (see GatewayConfigEventsModuleAsyncOptions).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => Promise<BgeRedisConnectionConfig> | BgeRedisConnectionConfig;
}

/**
 * Async configuration entry point for `RedisModule.forRootAsync`.
 *
 * Each connection is independently optional. Only the providers for the
 * connections you actually configure are registered in the DI container —
 * a consumer attempting to inject an unconfigured token will fail with a
 * clear "no provider found" error at module init.
 *
 * At least one connection must be configured.
 *
 * @example API process — both connections
 * ```typescript
 * RedisModule.forRootAsync({
 *   cache: {
 *     inject: [ConfigService],
 *     useFactory: (config: ConfigService) => config.getOrThrow('redis.cache'),
 *   },
 *   queue: {
 *     inject: [ConfigService],
 *     useFactory: (config: ConfigService) => config.getOrThrow('redis.queue'),
 *   },
 * });
 * ```
 *
 * @example Worker process — queue only
 * ```typescript
 * RedisModule.forRootAsync({
 *   queue: {
 *     inject: [ConfigService],
 *     useFactory: (config: ConfigService) => config.getOrThrow('redis.queue'),
 *   },
 * });
 * ```
 */
export interface BgeRedisModuleAsyncOptions {
  cache?: BgeRedisAsyncConnectionOptions;
  queue?: BgeRedisAsyncConnectionOptions;
}
