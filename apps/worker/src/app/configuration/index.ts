import Joi from 'joi';
import auth, { authConfigValidationSchema } from './auth.config';
import redisCache, { redisCacheValidationSchema } from './redis-cache.config';
import redis, { redisConfigValidationSchema } from './redis-queue.config';

export const configuration = {
  auth,
  redis,
  redisCache,
};

export const configurationValidationSchema = Joi.object({
  ...authConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisCacheValidationSchema,
});
