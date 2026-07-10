import { AuditContextModule } from '@bge/actor-context';
import { AuditLogModule, AuditRetentionModule } from '@bge/audit-log';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportConsumerModule } from '@bge/game-import';
import { MediaSweepModule } from '@bge/media';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry, DbPoolMetricsRecorderModule } from '@bge/otel';
import { WebhookQueueConsumerModule, WebhookQueueProducerModule } from '@bge/queue-webhooks';
import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT, Redis, RedisModule } from '@bge/redis';
import { StorageModule } from '@bge/storage';
import { WebhooksModule } from '@bge/webhooks';
import KeyvValkey from '@keyv/valkey';
import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import type { RedisClient } from 'bullmq';
import Keyv from 'keyv';
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

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [CACHE_REDIS_CLIENT, ConfigService],
      useFactory: (cacheClient: Redis, configService: ConfigService) => ({
        stores: [
          new Keyv({
            store: new KeyvValkey(cacheClient),
            namespace: 'worker:cache',
          }),
        ],
        ttl: configService.get<number>('cache.ttl'),
        max: configService.get<number>('cache.max'),
      }),
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

    // Periodic hard-delete of rejected DirectUpload contributions past their
    // reclaim window (issue #58 sweep). Worker-only so it runs once.
    MediaSweepModule,

    // Audit capture (onAny listener) for MutationEvents emitted during job
    // processing, plus the retention sweep — worker-only (like MediaSweepModule)
    // so the @Interval runs in exactly one process.
    AuditLogModule,
    AuditRetentionModule,

    // Add more consumer modules here as the worker gains capabilities
    GameImportConsumerModule,
    WebhookQueueConsumerModule,

    // Webhook domain providers + delivery-queue PRODUCER. The import
    // processor emits game.game.imported.v1 / game.import.failed.v1 /
    // game.import-batch.completed.v1 in this process, so the onAny
    // dispatcher must run here for those events to fan out to
    // subscriptions. (This process also consumes the delivery queue via
    // WebhookQueueConsumerModule above — producer and consumer are
    // independent registrations of the same queue.)
    WebhooksModule,
    WebhookQueueProducerModule,
  ],
})
export class WorkerModule {}
