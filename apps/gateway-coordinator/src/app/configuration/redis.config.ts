import { env, isTrue } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import type { RedisClientOptions } from 'redis';

export default registerAs('redis', () =>
  env.provideMany<RedisClientOptions>(
    [
      {
        keyTo: 'host',
        key: 'REDIS_HOST',
        defaultValue: 'localhost',
      },
      {
        keyTo: 'port',
        key: 'REDIS_PORT',
        defaultValue: 6379,
        mutators: parseInt,
      },
      {
        keyTo: 'database',
        key: 'REDIS_DATABASE',
        defaultValue: 0,
        mutators: parseInt,
      },
      {
        keyTo: 'username',
        key: 'REDIS_USERNAME',
        defaultValue: '',
        allowEmptyString: true,
      },
      {
        keyTo: 'password',
        key: 'REDIS_PASSWORD',
        defaultValue: '',
        allowEmptyString: true,
      },
      {
        keyTo: 'tlsEnabled',
        key: 'REDIS_TLS_ENABLED',
        defaultValue: false,
        mutators: isTrue,
      },
      {
        keyTo: 'rejectUnauthorized',
        key: 'REDIS_REJECT_UNAUTHORIZED',
        defaultValue: true,
        mutators: isTrue,
      },
      {
        keyTo: 'ca',
        key: 'REDIS_TLS_CA',
        defaultValue: '',
        allowEmptyString: true,
      },
      {
        keyTo: 'key',
        key: 'REDIS_TLS_KEY',
        defaultValue: '',
        allowEmptyString: true,
      },
      {
        keyTo: 'cert',
        key: 'REDIS_TLS_CERT',
        defaultValue: '',
        allowEmptyString: true,
      },
    ],
    (config) => ({
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
    }),
  ),
);

export const redisConfigValidationSchema = {
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_DATABASE: Joi.number().default(1),
  REDIS_USERNAME: Joi.string().optional().allow('').default(''),
  REDIS_PASSWORD: Joi.string().optional().allow('').default(''),
  REDIS_TLS_ENABLED: Joi.boolean().default(false),
  REDIS_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  REDIS_TLS_CA: Joi.string().optional().allow('').default(''),
  REDIS_TLS_KEY: Joi.string().optional().allow('').default(''),
  REDIS_TLS_CERT: Joi.string().optional().allow('').default(''),
};
