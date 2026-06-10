import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportFetchModule } from '@bge/game-import';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry } from '@bge/otel';
import { QUEUE_REDIS_CLIENT, RedisModule } from '@bge/redis';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { RedisClient } from 'bullmq';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import { baseLogger } from './lib/logger';

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
      global: true,
      wildcard: false,
      delimiter: '.',
      verboseMemoryLeak: true,
    }),

    // Shared Redis clients (iovalkey via @bge/redis). Gateway-worker needs
    // both connections — cache for gateway registry pub/sub, queue for
    // BullMQ workers consuming import-fetch jobs.
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

    // BullMQ telemetry attaches at the root so every Worker registered
    // downstream inherits it. bullmq-otel handles trace context restoration
    // at the queue boundary — spans created during job processing become
    // children of the producer's span.
    BullModule.forRootAsync({
      inject: [QUEUE_REDIS_CLIENT],
      useFactory: (queueClient: RedisClient) => ({
        connection: queueClient,
        telemetry: createBullMQTelemetry(),
      }),
    }),

    // Structured logging via pino, bridged to OpenTelemetry. The transport
    // (configured by `buildOtelPinoOptions`) activates when
    // `OTEL_EXPORTER_OTLP_ENDPOINT` is set and ships logs alongside spans.
    LoggerModule.forRoot({
      pinoHttp: {
        logger: baseLogger,
      },
    }),

    // Periodically calls `queue.recordJobCountsMetric()` on every
    // discovered Queue. On the consumer side, the recorder will only
    // discover queues that have been registered locally via
    // `BullModule.registerQueue`; that's fine — depth is a per-Redis-key
    // property, not per-process.
    BullMQQueueDepthRecorderModule,

    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: false,
        generateId: true,
        idGenerator: () => crypto.randomUUID(),
      },
    }),

    DatabaseModule,

    GatewayRegistryModule,

    GameImportFetchModule,
  ],
})
export class GatewayWorkerModule {}
