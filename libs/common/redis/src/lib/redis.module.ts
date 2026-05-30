import type { ModuleMetadata } from '@nestjs/common';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import type { Redis, RedisOptions } from 'iovalkey';
import { createRedisClient } from './redis-client.factory';
import {
  BgeRedisAsyncConnectionOptions,
  BgeRedisConnectionConfig,
  BgeRedisModuleAsyncOptions,
} from './redis-connection.config';
import { RedisLifecycleManager } from './redis-lifecycle.service';
import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT } from './redis.tokens';

/**
 * Global module providing shared ioredis clients for the BGE backend.
 *
 * Provides up to two injection tokens, each registered independently:
 *
 *   - `CACHE_REDIS_CLIENT` — for the cache (via @keyv/valkey), gateway
 *     config events pub/sub, and the Redis health indicator. Configured
 *     with `maxRetriesPerRequest: 3` for fail-fast cache semantics.
 *   - `QUEUE_REDIS_CLIENT` — for BullMQ `Queue` / `FlowProducer` instances.
 *     Configured with `maxRetriesPerRequest: null` per BullMQ requirements.
 *
 * Each connection is independently optional — only the providers for the
 * connections you configure are registered. This allows worker processes
 * to register only the queue connection, cache-only services to register
 * only the cache connection, and so on.
 *
 * Deliberately does NOT manage the Socket.IO streams adapter connection —
 * that adapter requires `node-redis` rather than ioredis and remains owned
 * by `RedisIoAdapter`. See docs/REDIS.md for the full connection topology.
 */
@Module({})
export class RedisModule {
  static forRootAsync(options: BgeRedisModuleAsyncOptions): DynamicModule {
    if (!options.cache && !options.queue) {
      throw new Error('RedisModule.forRootAsync requires at least one of `cache` or `queue` to be configured.');
    }

    const providers: Provider[] = [];
    const imports: ModuleMetadata['imports'] = [];

    if (options.cache) {
      providers.push(this.buildClientProvider(CACHE_REDIS_CLIENT, options.cache, { maxRetriesPerRequest: 3 }));
      imports.push(...(options.cache.imports ?? []));
    }

    if (options.queue) {
      providers.push(this.buildClientProvider(QUEUE_REDIS_CLIENT, options.queue, { maxRetriesPerRequest: null }));
      imports.push(...(options.queue.imports ?? []));
    }

    providers.push(RedisLifecycleManager);

    const exports_: Array<symbol> = [];
    if (options.cache) exports_.push(CACHE_REDIS_CLIENT);
    if (options.queue) exports_.push(QUEUE_REDIS_CLIENT);

    return {
      module: RedisModule,
      global: true,
      imports,
      providers,
      exports: exports_,
    };
  }

  /**
   * Builds a Provider that resolves the connection config via the consumer's
   * `useFactory` and constructs the iovalkey client with per-token overrides
   * (e.g. retry policy specific to BullMQ vs cache semantics).
   *
   * Construction goes through `createRedisClient` rather than `new Redis(...)`
   * directly — see that function's docstring for the rationale.
   */
  private static buildClientProvider(
    token: symbol,
    asyncOptions: BgeRedisAsyncConnectionOptions,
    overrides: Partial<RedisOptions> = {},
  ): Provider {
    return {
      provide: token,
      inject: asyncOptions.inject ?? [],
      // The DI container passes the resolved `inject` dependencies positionally;
      // we forward them to the consumer's factory and wrap the returned config
      // in an iovalkey client.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useFactory: async (...args: any[]): Promise<Redis> => {
        const config: BgeRedisConnectionConfig = await asyncOptions.useFactory(...args);
        return createRedisClient(config, overrides);
      },
    };
  }
}
