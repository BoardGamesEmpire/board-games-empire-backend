import Joi from 'joi';
import redisCache, { redisCacheValidationSchema } from './redis-cache.config';
import redis, { redisConfigValidationSchema } from './redis-queue.config';
import system, { systemConfigValidationSchema } from './system.config';

export const configuration = {
  system,
  redis,
  redisCache,
};

export const configurationValidationSchema = Joi.object({
  ...systemConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisCacheValidationSchema,
});
