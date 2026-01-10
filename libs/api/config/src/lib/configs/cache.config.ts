import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { env } from './env';

export interface CacheConfig {
  ttl: number;
  max: number;
}

export default registerAs('cache', () =>
  env.provideMany<CacheConfig>([
    {
      keyTo: 'ttl',
      key: 'CACHE_TTL',
      // 5 minutes in ms
      defaultValue: 1000 * 60 * 5,
      mutators: parseInt,
    },
    {
      keyTo: 'max',
      key: 'CACHE_MAX',
      defaultValue: 100,
      mutators: parseInt,
    },
  ]),
);

export const cacheConfigValidationSchema = {
  CACHE_TTL: Joi.number()
    .integer()
    .min(0)
    .default(60 * 5 * 1000),
  CACHE_MAX: Joi.number().integer().min(0).default(100),
};
