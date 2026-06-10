import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportConsumerModule } from '@bge/game-import';
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
import { bootstrapLogger } from './lib/logger';

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

    // Shared Redis client (iovalkey via @bge/redis). Worker configures the
    // queue connection only — it consumes BullMQ jobs but has no gateway
    // registry, no cache layer, and no health endpoints. If any downstream
    // consumer module unexpectedly tries to inject CACHE_REDIS_CLIENT, DI
    // will fail at startup with a clear "no provider" error.
    RedisModule.forRootAsync({
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
        logger: bootstrapLogger,
      },
    }),

    // Periodically drives bullmq-otel's queue depth gauge. Idle unless
    // metrics export is enabled.
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

    // Add more consumer modules here as the worker gains capabilities
    GameImportConsumerModule,
  ],
})
export class WorkerModule {}
