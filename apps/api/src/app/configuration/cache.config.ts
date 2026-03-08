import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface CacheConfig {
  ttl: number;
  max: number;
}

const FIVE_MINUTES_IN_MS = 1000 * 60 * 5;

export default registerAs('cache', () =>
  env.provideMany<CacheConfig>([
    {
      keyTo: 'ttl',
      key: 'CACHE_TTL',
      defaultValue: FIVE_MINUTES_IN_MS,
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
  CACHE_TTL: Joi.number().integer().min(0).default(FIVE_MINUTES_IN_MS),
  CACHE_MAX: Joi.number().integer().min(0).default(100),
};
