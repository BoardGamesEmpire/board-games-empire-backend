import { DynamicModule, InjectionToken, Module, ModuleMetadata, Provider } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { RAW_REDIS_TOKEN } from './constants/gateway-registry-redis.constants';
import { GATEWAY_REGISTRY_REDIS } from './constants/gateway-registry.constants';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayRegistryRedisLifecycle } from './gateway-registry-redis-lifecycle.provider';

export interface GatewayConfigEventsModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (...args: any[]) => Promise<RedisOptions> | RedisOptions;
}

/**
 * Lightweight module exposing the gateway config event publisher/subscriber.
 * Apps that only need to publish events (e.g., the API on admin mutations)
 * import this directly. Apps that also need full gateway connection
 * management import GatewayRegistryModule, which composes this module
 * internally.
 *
 * Global by design — the events service should be available app-wide
 * without explicit re-import in feature modules.
 */
@Module({})
export class GatewayConfigEventsModule {
  static forRootAsync(options: GatewayConfigEventsModuleAsyncOptions): DynamicModule {
    const rawRedisProvider: Provider = {
      provide: RAW_REDIS_TOKEN,
      inject: options.inject ?? [],
      useFactory: async (...args: unknown[]): Promise<Redis> => {
        const redisOptions = await options.useFactory(...args);
        return new Redis(redisOptions);
      },
    };

    const publicRedisProvider: Provider = {
      provide: GATEWAY_REGISTRY_REDIS,
      inject: [GatewayRegistryRedisLifecycle],
      useFactory: (lifecycle: GatewayRegistryRedisLifecycle): Redis => lifecycle.client,
    };

    return {
      module: GatewayConfigEventsModule,
      global: true,
      imports: [...(options.imports ?? [])],
      providers: [rawRedisProvider, GatewayRegistryRedisLifecycle, publicRedisProvider, GatewayConfigEventsService],
      exports: [GATEWAY_REGISTRY_REDIS, GatewayConfigEventsService],
    };
  }
}
