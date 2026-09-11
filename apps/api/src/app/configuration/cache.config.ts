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

/**
 * The Keyv namespace of the api's cache store: every key `CacheModule` writes
 * is stored as `${API_CACHE_NAMESPACE}:${key}`. Shared with the boot
 * sequence's cache flush (`main.ts`), whose SCAN patterns must name the
 * physical key, not the logical one (#236).
 */
export const API_CACHE_NAMESPACE = 'api:cache';
