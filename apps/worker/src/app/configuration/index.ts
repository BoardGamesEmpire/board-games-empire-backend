import Joi from 'joi';
import redis, { redisConfigValidationSchema } from './redis-queue.config';

export const configuration = {
  redis,
};

export const configurationValidationSchema = Joi.object({
  ...redisConfigValidationSchema,
});
