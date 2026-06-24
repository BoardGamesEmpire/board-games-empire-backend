import { AuditContextModule } from '@bge/actor-context';
import { ActorContextTransportModule, HttpActorMiddleware, WsActorInterceptor } from '@bge/actor-context-transport';
import { AuthModule } from '@bge/auth';
import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { EventModule } from '@bge/event';
import { FeedbackModule } from '@bge/feedback';
import { GameModule } from '@bge/game';
import { GameGatewayModule } from '@bge/game-gateway';
import { GameImportProducerModule } from '@bge/game-import';
import { GameSearchModule } from '@bge/game-search';
import { GatewayConfigEventsModule } from '@bge/gateway-registry';
import { HealthModule } from '@bge/health';
import { HouseholdModule } from '@bge/household';
import { LanguageModule } from '@bge/language';
import { MetricsModule } from '@bge/metrics';
import { NotificationsModule } from '@bge/notifications';
import { AbilityContextMiddleware, PermissionsModule } from '@bge/permissions';
import { QuotasModule } from '@bge/quotas';
import { CACHE_REDIS_CLIENT, RedisModule, type Redis } from '@bge/redis';
import { SafeHttpModule } from '@bge/safe-http';
import { SecureHttpModule } from '@bge/secure-http';
import { SystemSettingsModule } from '@bge/system-settings';
import { UserModule } from '@bge/user';
import { WebhookSubscriptionModule } from '@bge/webhook-subscription';
import { WellKnownModule } from '@bge/well-known';
import KeyvValkey from '@keyv/valkey';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import Keyv from 'keyv';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import { GameSearchGateway } from './gateways/game/search.gateway';
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
    // Redis pub/sub handles immediate updates; this catches any message missed
    // during a transient Redis disconnect.
    ScheduleModule.forRoot(),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.getOrThrow<number>('throttle.ttl'),
            limit: config.getOrThrow<number>('throttle.limit'),
          },
        ],
      }),
    }),

    DatabaseModule,
    SecureHttpModule,

    // Shared Redis clients (ioredis). Owns the lifecycle of the cache and
    // queue connections used across the application.
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
            namespace: 'api:cache',
          }),
        ],
        ttl: configService.get<number>('cache.ttl'),
        max: configService.get<number>('cache.max'),
      }),
    }),

    // Structured logging via pino, bridged to OpenTelemetry. `pinoHttp`
    // carries the OTel trace correlation mixin and conditionally
    // configures `pino-opentelemetry-transport` (active when
    // `OTEL_EXPORTER_OTLP_ENDPOINT` is set). The transport runs in a pino
    // worker thread and ships logs to the OTLP collector alongside spans.
    //
    // Uses `baseLogger` (not `bootstrapLogger`): the latter carries a
    // `component: 'bootstrap'` binding intended for pre-Nest log lines,
    // and passing it here would tag every runtime log as a bootstrap
    // log.
    LoggerModule.forRoot({
      forRoutes: ['*'],
      pinoHttp: {
        logger: baseLogger,
      },
    }),

    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: false,
        generateId: true,
        idGenerator: (req: Request) => <string>req?.headers?.['x-request-id'] || crypto.randomUUID(),
      },
    }),

    // Gateway config events — depends on the global CACHE_REDIS_CLIENT
    // provided by RedisModule. The service uses the shared cache connection
    // for publishing and duplicates it internally for the subscriber side.
    GatewayConfigEventsModule,

    ActorContextTransportModule,
    AuditContextModule,

    // Feature modules
    AuthModule,
    EventModule,
    FeedbackModule,
    GameGatewayModule,
    GameImportProducerModule,
    GameSearchModule,
    GameModule,
    GatewayCoordinatorClientModule,
    HealthModule,
    HouseholdModule,
    LanguageModule,
    MetricsModule,
    NotificationsModule,
    PermissionsModule,
    QuotasModule,
    SafeHttpModule,
    SystemSettingsModule,
    UserModule,
    WebhookSubscriptionModule,
    WellKnownModule,
  ],
  controllers: [],
  providers: [
    { provide: APP_INTERCEPTOR, useExisting: WsActorInterceptor },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },

    // Global guards
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },

    // WS Gateways
    GameSearchGateway,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    // Order matters: HttpActorMiddleware populates the CLS actor, and
    // AbilityContextMiddleware reads that actor to resolve and prime the
    // per-request ability array. Both run before guards, so PoliciesGuard
    // (which reads the primed abilities via AbilityService) sees them.
    consumer.apply(ClsMiddleware, HttpActorMiddleware, AbilityContextMiddleware).forRoutes('*');
  }
}
