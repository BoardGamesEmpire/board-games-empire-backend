import Joi from 'joi';
import coordinatorConfig, { coordinatorConfigValidationSchema } from './coordinator.config';

export const configuration = {
  coordinator: coordinatorConfig,
};

export const configurationValidationSchema = Joi.object({
  ...coordinatorConfigValidationSchema,
});
