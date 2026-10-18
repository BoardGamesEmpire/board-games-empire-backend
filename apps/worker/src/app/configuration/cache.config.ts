import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface CacheConfig {
  ttl: number;
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
  ]),
);

export const cacheConfigValidationSchema = {
  CACHE_TTL: Joi.number().integer().min(1).default(FIVE_MINUTES_IN_MS),
};
