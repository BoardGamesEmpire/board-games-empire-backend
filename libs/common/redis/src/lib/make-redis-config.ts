import { env, isTrue } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import type { BgeRedisConnectionConfig } from './redis-connection.config';

/**
 * Options for {@link makeRedisConfig}.
 *
 * A single deployment runs several logical Redis connections (cache, queue,
 * websocket) that are structurally identical — they differ only in the
 * `ConfigService` namespace they register under, the environment-variable
 * prefix they read from, and the default logical database index.
 */
export interface MakeRedisConfigOptions {
  /**
   * `ConfigService` namespace the connection registers under, e.g.
   * `'redis.cache'`, `'redis.queue'`, `'redis.websocket'`.
   */
  namespace: string;

  /**
   * Environment-variable prefix for this connection, e.g. `'REDIS_'`,
   * `'REDIS_BULLMQ_'`, `'REDIS_WEBSOCKET_'`. The full set of keys is derived
   * from it (`${prefix}HOST`, `${prefix}PORT`, `${prefix}DATABASE`, …).
   */
  envPrefix: string;

  /**
   * Default logical database index used when `${envPrefix}DATABASE` is unset.
   * Defaults to `0`.
   */
  database?: number;
}

/**
 * Builds a namespaced Redis connection config + its Joi validation schema from
 * a single (namespace, envPrefix, database) triple.
 *
 * Collapses the ~10 near-identical per-app `redis*.config.ts` files that
 * previously hand-rolled the same env mapping, transform, and validation
 * schema. The produced connection object matches {@link BgeRedisConnectionConfig}
 * so it can drive both a Keyv-backed cache store and a raw ioredis/iovalkey
 * client.
 *
 * @example
 * ```typescript
 * const { config, validationSchema } = makeRedisConfig({
 *   namespace: 'redis.cache',
 *   envPrefix: 'REDIS_',
 *   database: 0,
 * });
 * export default config;
 * export const redisConfigValidationSchema = validationSchema;
 * ```
 */
export function makeRedisConfig({ namespace, envPrefix, database = 0 }: MakeRedisConfigOptions) {
  const key = (suffix: string) => `${envPrefix}${suffix}`;

  const config = registerAs(namespace, () =>
    env.provideMany<BgeRedisConnectionConfig>(
      [
        { keyTo: 'host', key: key('HOST'), defaultValue: 'localhost' },
        { keyTo: 'port', key: key('PORT'), defaultValue: 6379, mutators: parseInt },
        { keyTo: 'database', key: key('DATABASE'), defaultValue: database, mutators: parseInt },
        { keyTo: 'username', key: key('USERNAME'), defaultValue: '', allowEmptyString: true },
        { keyTo: 'password', key: key('PASSWORD'), defaultValue: '', allowEmptyString: true },
        { keyTo: 'tlsEnabled', key: key('TLS_ENABLED'), defaultValue: false, mutators: isTrue },
        {
          keyTo: 'rejectUnauthorized',
          key: key('REJECT_UNAUTHORIZED'),
          defaultValue: true,
          mutators: isTrue,
        },
        { keyTo: 'ca', key: key('TLS_CA'), defaultValue: '', allowEmptyString: true },
        { keyTo: 'key', key: key('TLS_KEY'), defaultValue: '', allowEmptyString: true },
        { keyTo: 'cert', key: key('TLS_CERT'), defaultValue: '', allowEmptyString: true },
      ],
      (config) =>
        ({
          username: config.username,
          password: config.password || undefined,
          database: config.database || undefined,
          socket: {
            host: config.host,
            port: config.port,
            tls: config.tlsEnabled,
            ca: config.tlsEnabled ? config.ca : undefined,
            key: config.tlsEnabled ? config.key : undefined,
            cert: config.tlsEnabled ? config.cert : undefined,
            rejectUnauthorized: config.tlsEnabled ? config.rejectUnauthorized : undefined,
          },
        }) satisfies BgeRedisConnectionConfig,
    ),
  );

  const validationSchema: Record<string, Joi.Schema> = {
    [key('HOST')]: Joi.string().default('localhost'),
    [key('PORT')]: Joi.number().default(6379),
    [key('DATABASE')]: Joi.number().default(database),
    [key('USERNAME')]: Joi.string().optional().allow('').default(''),
    [key('PASSWORD')]: Joi.string().optional().allow('').default(''),
    [key('TLS_ENABLED')]: Joi.boolean().default(false),
    [key('REJECT_UNAUTHORIZED')]: Joi.boolean().default(true),
    [key('TLS_CA')]: Joi.string().optional().allow('').default(''),
    [key('TLS_KEY')]: Joi.string().optional().allow('').default(''),
    [key('TLS_CERT')]: Joi.string().optional().allow('').default(''),
  };

  return { config, validationSchema };
}
