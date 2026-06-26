import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportConsumerModule } from '@bge/game-import';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry, DbPoolMetricsRecorderModule } from '@bge/otel';
import { WebhookQueueConsumerModule } from '@bge/queue-webhooks';
import { QUEUE_REDIS_CLIENT, RedisModule } from '@bge/redis';
import { StorageModule } from '@bge/storage';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
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
      envFilePath: env.isProduction ? undefined : '.env',
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

    // Drives the SafeHttpPolicyService periodic-refresh backstop (@Interval).
    // The Redis pub/sub subscription handles immediate updates; this catches
    // any pub/sub message missed during a transient Redis disconnect.
    ScheduleModule.forRoot(),

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
    DbPoolMetricsRecorderModule,
    StorageModule,

    // Provides AuditContextInternalService for the now actor-aware
    // GameImportProcessor; the global ClsModule.forRoot above satisfies its CLS
    // requirement (runWith establishes the context — no HTTP middleware needed).
    AuditContextModule,

    // Add more consumer modules here as the worker gains capabilities
    GameImportConsumerModule,
    WebhookQueueConsumerModule,
  ],
})
export class WorkerModule {}
