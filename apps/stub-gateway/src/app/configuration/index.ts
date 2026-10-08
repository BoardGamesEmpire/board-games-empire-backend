import Joi from 'joi';
import gatewayConfig, { gatewayConfigValidationSchema } from './gateway.config';

export const configuration = {
  gateway: gatewayConfig,
};

export const configurationValidationSchema = Joi.object({
  ...gatewayConfigValidationSchema,
});
