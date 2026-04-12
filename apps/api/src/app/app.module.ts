import { AuthModule } from '@bge/auth';
import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { EventModule } from '@bge/event';
import { GameModule } from '@bge/game';
import { GameGatewayModule } from '@bge/game-gateway';
import { GameImportModule } from '@bge/game-import';
import { GameSearchModule } from '@bge/game-search';
import { HealthModule } from '@bge/health';
import { HouseholdModule } from '@bge/household';
import { LanguageModule } from '@bge/language';
import { MetricsModule } from '@bge/metrics';
import { NotificationsModule } from '@bge/notifications';
import { ContextGuard, PermissionsModule } from '@bge/permissions';
import { SystemSettingsModule } from '@bge/system-settings';
import { UserModule } from '@bge/user';
import KeyvRedis, { RedisClientOptions } from '@keyv/redis';
import { BullModule } from '@nestjs/bullmq';
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
import type { RedisOptions } from './configuration/redis.config';
import { GameImportGateway } from './gateways/game/import.gateway';
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

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisConfig = config.getOrThrow<RedisOptions>('redis.queue');
        return {
          connection: {
            host: redisConfig.socket.host,
            port: redisConfig.socket.port,
            username: redisConfig.username,
            password: redisConfig.password,
            database: redisConfig.database,
          },
        };
      },
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

    // Feature modules
    AuthModule,
    EventModule,
    GameGatewayModule,
    GameImportModule,
    GameModule,
    GatewayCoordinatorClientModule,
    HealthModule,
    HouseholdModule,
    LanguageModule,
    MetricsModule,
    NotificationsModule,
    PermissionsModule,
    GameSearchModule,
    SystemSettingsModule,
    UserModule,
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

    // Gateways
    GameImportGateway,
    GameSearchGateway,
  ],
})
export class AppModule {}
