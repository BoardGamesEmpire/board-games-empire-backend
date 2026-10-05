import Joi from 'joi';
import { igdbConfigValidationSchema } from '../igdb/configuration';
import gatewayConfig, { gatewayConfigValidationSchema } from './gateway.config';

export const configuration = {
  gateway: gatewayConfig,
};

/**
 * The igdb module loads its own config through `ConfigModule.forFeature`,
 * which validates nothing. Only `forRoot` runs a schema, so the igdb keys are
 * checked here or not at all.
 */
export const configurationValidationSchema = Joi.object({
  ...gatewayConfigValidationSchema,
  ...igdbConfigValidationSchema,
});
