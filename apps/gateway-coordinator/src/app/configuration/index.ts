import Joi from 'joi';
import coordinatorConfig, { coordinatorConfigValidationSchema } from './coordinator.config';
import redisConfig, { redisConfigValidationSchema } from './redis.config';

export const configuration = {
  coordinator: coordinatorConfig,
  redis: redisConfig,
};

export const configurationValidationSchema = Joi.object({
  ...coordinatorConfigValidationSchema,
  ...redisConfigValidationSchema,
});
