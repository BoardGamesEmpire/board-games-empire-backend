import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import coordinatorConfig, { coordinatorConfigValidationSchema } from './coordinator.config';
import redisQueueConfig, { redisQueueConfigValidationSchema } from './redis-queue.config';
import redisConfig, { redisConfigValidationSchema } from './redis.config';

export const configuration = {
  coordinator: coordinatorConfig,
  redisQueue: redisQueueConfig,
  redis: redisConfig,
  cache: cache,
};

export const configurationValidationSchema = Joi.object({
  ...coordinatorConfigValidationSchema,
  ...redisQueueConfigValidationSchema,
  ...cacheConfigValidationSchema,
  ...redisConfigValidationSchema,
});
