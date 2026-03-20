import Joi from 'joi';
import igdbConfig, { igdbConfigValidationSchema } from './igdb.config';

export const configuration = {
  igdb: igdbConfig,
};

export const configurationValidationSchema = Joi.object({
  ...igdbConfigValidationSchema,
});
