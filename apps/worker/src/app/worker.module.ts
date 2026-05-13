import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GameImportConsumerModule } from '@bge/game-import';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import * as crypto from 'node:crypto';
import { configuration, configurationValidationSchema } from './configuration';
import type { RedisOptions } from './configuration/redis-queue.config';

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

    // Add more consumer modules here as the worker gains capabilities
    GameImportConsumerModule,
  ],
})
export class WorkerModule {}
