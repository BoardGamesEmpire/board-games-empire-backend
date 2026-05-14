import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { GatewayRegistryModule } from '@bge/gateway-registry';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { configuration, configurationValidationSchema } from './configuration';
import type { RedisOptions } from './configuration/redis.config';
import { CoordinatorModule } from './coordinator/coordinator.module';

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

    DatabaseModule,
    CoordinatorModule,
  ],
})
export class AppModule {}
