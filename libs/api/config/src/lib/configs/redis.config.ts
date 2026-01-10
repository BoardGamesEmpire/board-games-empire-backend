import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { env } from './env';
import { isTrue } from './helpers/helpers';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  tls?: {
    rejectUnauthorized: boolean;
    ca: string;
    key: string;
    cert: string;
  };
}

export default registerAs('redis', () =>
  env.provideMany<RedisConfig>(
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
        keyTo: 'password',
        key: 'REDIS_PASSWORD',
        defaultValue: '',
        allowEmptyString: true,
      },
      {
        keyTo: 'tls',
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
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      tls: config.tls
        ? {
            rejectUnauthorized: config.rejectUnauthorized,
            ca: config.ca || undefined,
            key: config.key || undefined,
            cert: config.cert || undefined,
          }
        : undefined,
    }),
  ),
);

export const redisConfigValidationSchema = {
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_TLS_ENABLED: Joi.boolean().default(false),
  REDIS_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  REDIS_TLS_CA: Joi.string().allow('').default(''),
  REDIS_TLS_KEY: Joi.string().allow('').default(''),
  REDIS_TLS_CERT: Joi.string().allow('').default(''),
};
