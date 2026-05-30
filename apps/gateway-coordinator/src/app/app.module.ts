import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { QUEUE_REDIS_CLIENT, RedisModule } from '@bge/redis';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { RedisClient } from 'bullmq';
import { configuration, configurationValidationSchema } from './configuration';
import { CoordinatorModule } from './coordinator/coordinator.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [...Object.values(configuration)],
      cache: true,
      isGlobal: true,
      expandVariables: true,
      validationSchema: configurationValidationSchema,
      validationOptions: {
        abortEarly: true,
        cache: !env.isProduction,
        debug: !env.isProduction,
        stack: !env.isProduction,
      },
    }),

    EventEmitterModule.forRoot({
      wildcard: true,
      global: true,
    }),

    // Shared Redis clients (iovalkey via @bge/redis). Coordinator needs both:
    //   - cache: gateway registry pub/sub (config event invalidation)
    //   - queue: BullMQ producer side for coordinator-owned queues
    RedisModule.forRootAsync({
      cache: {
        inject: [ConfigService],
        useFactory: (config: ConfigService) => config.getOrThrow('redis.cache'),
      },
      queue: {
        inject: [ConfigService],
        useFactory: (config: ConfigService) => config.getOrThrow('redis.queue'),
      },
    }),

    // BullMQ uses the shared queue connection. Workers (registered via
    // BullModule.registerQueue in downstream feature modules) will internally
    // duplicate this client for their blocking BRPOP — unavoidable, but at
    // least the producer side is shared.
    BullModule.forRootAsync({
      inject: [QUEUE_REDIS_CLIENT],
      useFactory: (queueClient: RedisClient) => ({
        connection: queueClient,
      }),
    }),

    // Gateway registry pub/sub uses the global CACHE_REDIS_CLIENT. The
    // service internally calls `.duplicate()` to get a dedicated subscriber
    // connection (ioredis pub/sub requires connection isolation in
    // subscribe mode).
    GatewayRegistryModule,

    DatabaseModule,
    CoordinatorModule,
  ],
})
export class AppModule {}
