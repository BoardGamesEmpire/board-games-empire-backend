import { AuditContextModule } from '@bge/actor-context';
import { GrpcInternalActorInterceptor } from '@bge/actor-context-transport';
import { AuditLogModule } from '@bge/audit-log';
import { DatabaseModule } from '@bge/database';
import { GatewayPluginHostModule } from '@bge/gateway-plugin-host';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { BullMQQueueDepthRecorderModule, createBullMQTelemetry, DbPoolMetricsRecorderModule } from '@bge/otel';
import { PluginModule } from '@bge/plugin';
import { QUEUE_REDIS_CLIENT, RedisModule } from '@bge/redis';
import { SecureHttpModule } from '@bge/secure-http';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import type { RedisClient } from 'bullmq';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configModuleOptions } from './configuration';
import { CoordinatorModule } from './coordinator/coordinator.module';
import { baseLogger } from './lib/logger';
import { coordinatorPluginModuleOptions } from './plugin-module.options';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),

    EventEmitterModule.forRoot({
      wildcard: true,
      global: true,
    }),

    // Runs the plugin load recorder's heartbeat (#1083). Without it this
    // process's plugin load records go stale after five minutes: the gateway
    // worker, which asks them whether a plugin is loaded, stops routing to
    // every plugin DataGateway, and the api's artifact sweep stops honouring
    // them and may remove the directory of a plugin artifact this process
    // loaded. It also runs the plugin config refresh and the outbound HTTP
    // policy refresh, the backstops for a change whose Redis message this
    // process missed.
    ScheduleModule.forRoot(),

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

    // The outbound HTTP policy each plugin's HTTP client is held to.
    SecureHttpModule,

    // The plugin runtime, loading only the data-gateway plugins, which this
    // process hosts (#1083). Its prerequisites (global CLS, the event
    // emitter, Redis, the database, the scheduler and the outbound HTTP
    // policy) are all mounted in this module.
    PluginModule.forRootAsync({
      inject: [ConfigService],
      useFactory: coordinatorPluginModuleOptions,
    }),

    // Gives the gateway registry the plugin DataGateways' drivers, built from
    // the plugins loaded above, and serves them over the gateway gRPC
    // protocol, which `main.ts` serves beside the coordinator's own (#1083).
    GatewayPluginHostModule,

    CoordinatorModule,

    // Audit capture (onAny listener) for MutationEvents emitted in this
    // process (e.g. gateway-registry mutations reached over gRPC).
    AuditLogModule,
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
