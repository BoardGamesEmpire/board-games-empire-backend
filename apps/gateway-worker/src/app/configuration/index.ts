import Joi from 'joi';
import redisBullmq, { redisConfigValidationSchema as redisBullmqConfigValidationSchema } from './redis-queue.config';
import redis, { redisConfigValidationSchema } from './redis.config';

export const configuration = {
  redis,
  redisBullmq,
};

export const configurationValidationSchema = Joi.object({
  ...redisConfigValidationSchema,
  ...redisBullmqConfigValidationSchema,
});
