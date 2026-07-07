import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import Joi from 'joi';
import cacheConfig, { cacheConfigValidationSchema } from './cache.config';
import redisCache, { redisCacheValidationSchema } from './redis-cache.config';
import redis, { redisConfigValidationSchema } from './redis-queue.config';
import system, { systemConfigValidationSchema } from './system.config';

export const configuration = {
  cacheConfig,
  mediaConfig,
  redis,
  redisCache,
  system,
};

export const configurationValidationSchema = Joi.object({
  ...cacheConfigValidationSchema,
  ...mediaConfigValidationSchema,
  ...redisCacheValidationSchema,
  ...redisConfigValidationSchema,
  ...systemConfigValidationSchema,
});
