import { AuthModule } from '@bge/auth';
import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { EventModule } from '@bge/event';
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
import { ContextGuard, PermissionsModule } from '@bge/permissions';
import { SystemSettingsModule } from '@bge/system-settings';
import { UserModule } from '@bge/user';
import { WellKnownModule } from '@bge/well-known';
import KeyvRedis, { RedisClientOptions } from '@keyv/redis';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import { GameSearchGateway } from './gateways/game/search.gateway';

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
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      async useFactory(configService: ConfigService) {
        const options = configService.getOrThrow<RedisClientOptions>('redis.cache');
        return {
          stores: [new KeyvRedis(options)],
          ttl: configService.get<number>('cache.ttl'),
          max: configService.get<number>('cache.max'),
        };
      },
    }),

    // Logging
    LoggerModule.forRoot({
      forRoutes: ['*'],
    }),

    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => <string>req?.headers?.['x-request-id'] || crypto.randomUUID(),
      },
    }),

    GatewayConfigEventsModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.getOrThrow('redis.cache');
        return {
          host: redis.socket.host,
          port: redis.socket.port,
          username: redis.username,
          password: redis.password,
          db: redis.database,
          tls: redis.socket.tls
            ? {
                ca: redis.socket.ca,
                cert: redis.socket.cert,
                key: redis.socket.key,
                rejectUnauthorized: redis.socket.rejectUnauthorized,
              }
            : undefined,
        };
      },
    }),

    // Feature modules
    AuthModule,
    EventModule,
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
    SystemSettingsModule,
    UserModule,
    WellKnownModule,
  ],
  controllers: [],
  providers: [
    // Global guards
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ContextGuard,
    },

    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },

    // WS Gateways
    GameSearchGateway,
  ],
})
export class AppModule {}
