import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import Joi from 'joi';
import redisCache, { redisCacheValidationSchema } from './redis-cache.config';
import redis, { redisConfigValidationSchema } from './redis-queue.config';
import system, { systemConfigValidationSchema } from './system.config';

export const configuration = {
  mediaConfig,
  redis,
  redisCache,
  system,
};

export const configurationValidationSchema = Joi.object({
  ...mediaConfigValidationSchema,
  ...redisCacheValidationSchema,
  ...redisConfigValidationSchema,
  ...systemConfigValidationSchema,
});
