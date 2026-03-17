import Joi from 'joi';
import gatewayConfig, { gatewayConfigValidationSchema } from './gateway.config';
import igdbConfig, { igdbConfigValidationSchema } from './igdb.config';

export const configuration = {
  gateway: gatewayConfig,
  igdb: igdbConfig,
};

export const configurationValidationSchema = Joi.object({
  ...gatewayConfigValidationSchema,
  ...igdbConfigValidationSchema,
});
