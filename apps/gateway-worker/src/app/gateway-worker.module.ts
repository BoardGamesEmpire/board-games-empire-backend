import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportFetchModule } from '@bge/game-import';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry, DbPoolMetricsRecorderModule } from '@bge/otel';
import { WebhookQueueProducerModule } from '@bge/queue-webhooks';
import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT, Redis, RedisModule } from '@bge/redis';
import { WebhooksModule } from '@bge/webhooks';
import KeyvValkey from '@keyv/valkey';
import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
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

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [CACHE_REDIS_CLIENT],
      useFactory: (cacheClient: Redis) => ({
        stores: [
          new Keyv({
            store: new KeyvValkey(cacheClient),
            namespace: 'gateway-worker:cache',
          }),
        ],
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

    // Actor-context CLS reader. The dispatcher reads the originating actor at
    // enqueue, so it must resolve AuditContextService here. @Global; ClsModule.forRoot
    // above satisfies its CLS requirement. Also the basis for #57 actor
    // propagation through import jobs, which this worker wants regardless.
    AuditContextModule,

    // Webhook domain providers (registry, signer, visibility). @Global, but must
    // be registered in this process for the dispatcher to resolve them.
    WebhooksModule,

    // Webhook delivery queue PRODUCER. Its onAny dispatcher runs in this process
    // so import-completion events emitted here fan out to subscriptions. Enqueues
    // to the shared delivery queue; the consumer lives in apps/worker.
    WebhookQueueProducerModule,

    DatabaseModule,
    DbPoolMetricsRecorderModule,

    GatewayRegistryModule,

    GameImportFetchModule,
  ],
})
export class GatewayWorkerModule {}
