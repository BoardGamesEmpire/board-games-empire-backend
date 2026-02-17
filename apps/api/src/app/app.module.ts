import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { HealthModule } from '@bge/health';
import { MetricsModule } from '@bge/metrics';
import { UsersModule } from '@bge/users';
import KeyvRedis from '@keyv/redis';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';

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
      useFactory: async (configService: ConfigService) => ({
        stores: [new KeyvRedis(configService.get('redis'))],
        ttl: configService.get<number>('cache.ttl'),
        max: configService.get<number>('cache.max'),
      }),
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
    UsersModule,
    HealthModule,
    MetricsModule,
  ],
  controllers: [],
  providers: [
    // Global guards
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
  ],
})
export class AppModule {}
