import { ApiConfigModule } from '@bge/api-config';
import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { MetricsModule } from '@bge/metrics';
import { UsersModule } from '@bge/users';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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

    // Feature modules
    AuthModule,
    UsersModule,
    MetricsModule,
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
