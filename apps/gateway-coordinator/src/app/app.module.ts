import { AuditContextModule } from '@bge/actor-context';
import { GrpcInternalActorInterceptor } from '@bge/actor-context-transport';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry, DbPoolMetricsRecorderModule } from '@bge/otel';
import { QUEUE_REDIS_CLIENT, RedisModule } from '@bge/redis';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import type { RedisClient } from 'bullmq';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import { CoordinatorModule } from './coordinator/coordinator.module';
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

    // BullMQ uses the shared queue connection. `telemetry` is wired
    // here at the root so every Queue/Worker registered downstream via
    // `BullModule.registerQueue(...)` / `@Processor(...)` inherits it.
    // bullmq-otel handles trace context propagation across job
    // boundaries, lifecycle spans (`add`, `getJob`, processing), and —
    // when `OTEL_METRICS_EXPORTER=otlp` — job-level counters and the
    // duration histogram. Queue depth gauge values are driven by
    // `BullMQQueueDepthRecorderModule` below.
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
    // discovered Queue so bullmq-otel's `bullmq.queue.jobs` gauge stays
    // fresh by the time the OTel SDK exports it. Idle when metrics
    // export is not enabled.
    BullMQQueueDepthRecorderModule,

    // CLS is registered without HTTP middleware mount — the coordinator
    // has no HTTP entry point. `GrpcInternalActorInterceptor` opens its
    // own CLS scope per inbound gRPC call via `auditContext.runWith`.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: false,
        generateId: true,
        idGenerator: () => crypto.randomUUID(),
      },
    }),

    // AuditContextModule provides AuditContextInternalService (CLS populator)
    // and AuditContextService (CLS reader). Required by the inbound gRPC
    // actor interceptor below.
    AuditContextModule,

    // Gateway registry pub/sub uses the global CACHE_REDIS_CLIENT. The
    // service internally calls `.duplicate()` to get a dedicated subscriber
    // connection (ioredis pub/sub requires connection isolation in
    // subscribe mode).
    GatewayRegistryModule,

    DatabaseModule,
    DbPoolMetricsRecorderModule,
    CoordinatorModule,
  ],
  providers: [
    // Reads `x-bge-actor` metadata from inbound gRPC calls and populates
    // CLS for downstream handlers. Trust model: the channel itself is the
    // boundary (mTLS / network policy in prod, loopback in dev). Missing
    // metadata throws `UnauthorizedException` — on a trusted internal
    // channel, absent actor context indicates a caller-side bug.
    { provide: APP_INTERCEPTOR, useClass: GrpcInternalActorInterceptor },
  ],
})
export class AppModule {}
