import { ApiConfigModule } from '@bge/api-config';
import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { UsersModule } from '@bge/users';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';

@Module({
  imports: [
    ApiConfigModule,

    // Rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
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

    // TODO: Move to a separate module
    PrometheusModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        defaultMetrics: {
          enabled: config.getOrThrow<boolean>('prometheus.defaultMetrics.enabled'),
          config: {
            prefix: config.get<string>('prometheus.defaultMetrics.prefix'),
            timeout: config.get<number>('prometheus.defaultMetrics.timeout'),
          },
        },
        defaultLabels: { app: 'BoardGamesEmpire' },
      }),
    }),

    // AuthModule.forRootAsync({
    //   imports: [DatabaseModule, ConfigModule],
    //   useFactory: (databaseClient: DatabaseService, configService: ConfigService) => {
    //     assert(databaseClient, 'DatabaseClient is required to initialize AuthModule');
    //     assert(configService, 'ConfigService is required to initialize AuthModule');

    //     const auth = authFactory(databaseClient, configService);
    //     return { auth };
    //   },
    //   inject: [DatabaseService, ConfigService],
    // }),

    // Feature modules
    AuthModule,
    UsersModule,
  ],
  controllers: [],
  providers: [
    // Global guards
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
