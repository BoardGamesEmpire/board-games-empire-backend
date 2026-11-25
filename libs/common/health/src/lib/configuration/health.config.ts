import { env, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface HealthConfig {
  httpHealthCheckUrls: string[];
}

export default registerAs('health', () =>
  env.provideMany<HealthConfig>([
    {
      keyTo: 'httpHealthCheckUrls',
      key: 'HTTP_HEALTH_CHECK_URLS',
      // Empty: a fresh server sends nothing to a third party unasked (#1509).
      defaultValue: '',
      mutators: (value) => splitTrimFilter(value),
    },
  ]),
);

/**
 * For the api's root schema. Validation only, so the config above is what
 * defaults each variable: a schema's default is written into the environment
 * and beats the config's (#626). Each accepts `''`, which `@bge/env` reads as
 * unset.
 */
export const healthConfigValidationSchema = {
  HTTP_HEALTH_CHECK_URLS: Joi.string().allow(''),
};
