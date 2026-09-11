import { DatabaseModule, databaseConfig, databaseConfigValidationSchema } from '@bge/database';
import { env } from '@bge/env';
import { createRedisClient, type BgeRedisConnectionConfig } from '@bge/redis';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { BOOTSTRAP_OPTIONS, CACHE_FLUSH, type BootstrapModuleOptions } from './bootstrap-options';
import { BootstrapService } from './bootstrap.service';
import { RedisKeyFlush } from './redis-key-flush';

/**
 * The standalone context the boot sequence runs in, before the application
 * module exists (#236). Deliberately small: configuration for the database
 * URL, the database, and the service; with a cache (the api), the same Redis
 * connection config its `CacheModule` will use and the flush over a client of
 * its own. It reads the same `.env` the application reads outside production,
 * so a developer's `DATABASE_URL` is the one that gets migrated.
 */
@Module({})
export class BootstrapModule {
  static forRoot(options: BootstrapModuleOptions): DynamicModule {
    const { cache } = options;
    const cacheProviders: Provider[] = cache
      ? [
          {
            provide: CACHE_FLUSH,
            inject: [cache.redis.config.KEY],
            useFactory: (connection: BgeRedisConnectionConfig) => {
              // Lazy, so a boot whose reconcile writes nothing never connects
              // and Redis being down can fail only the flush. Its failure
              // surfaces through the flush's rejection; without a listener
              // iovalkey would print every reconnect attempt on its own.
              const client = createRedisClient(connection, {
                lazyConnect: true,
                maxRetriesPerRequest: 3,
                connectionName: `bge-bootstrap:${options.applicationName}`,
              });
              client.on('error', () => undefined);
              return new RedisKeyFlush(client, cache.flushPatterns);
            },
          },
        ]
      : [];

    return {
      module: BootstrapModule,
      imports: [
        ConfigModule.forRoot({
          load: [databaseConfig, ...(cache ? [cache.redis.config] : [])],
          envFilePath: env.isProduction ? undefined : '.env',
          cache: true,
          isGlobal: true,
          expandVariables: true,
          validationSchema: Joi.object({ ...databaseConfigValidationSchema, ...cache?.redis.validationSchema }),
          validationOptions: { abortEarly: true, allowUnknown: true },
        }),
        DatabaseModule,
      ],
      providers: [{ provide: BOOTSTRAP_OPTIONS, useValue: options }, ...cacheProviders, BootstrapService],
      exports: [BootstrapService],
    };
  }
}
