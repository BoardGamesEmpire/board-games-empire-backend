import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportFetchModule } from '@bge/game-import';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import type { RedisOptions } from './configuration/redis.config';

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
            ...(redisConfig.socket.tls
              ? {
                  tls: {
                    ca: redisConfig.socket.ca,
                    cert: redisConfig.socket.cert,
                    key: redisConfig.socket.key,
                  },
                }
              : {}),
          },
        };
      },
    }),

    LoggerModule.forRoot({}),

    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: false,
        generateId: true,
        idGenerator: () => crypto.randomUUID(),
      },
    }),

    DatabaseModule,

    GatewayRegistryModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.getOrThrow<RedisOptions>('redis.cache');
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

    GameImportFetchModule,
  ],
})
export class GatewayWorkerModule {}
