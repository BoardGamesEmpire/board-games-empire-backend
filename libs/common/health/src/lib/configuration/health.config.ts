import { env, isTrue, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface HealthConfig {
  httpHealthCheckUrls: string[];
  enableHealthChecks: boolean;
}

export default registerAs('health', () =>
  env.provideMany<HealthConfig>([
    {
      keyTo: 'httpHealthCheckUrls',
      key: 'HTTP_HEALTH_CHECK_URLS',
      defaultValue: 'google|https://www.google.com,github|https://www.github.com',
      mutators: (value) => splitTrimFilter(value),
    },
    {
      keyTo: 'enableHealthChecks',
      key: 'ENABLE_HEALTH_CHECKS',
      defaultValue: true,
      mutators: isTrue,
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
  ENABLE_HEALTH_CHECKS: Joi.boolean().allow(''),
};
