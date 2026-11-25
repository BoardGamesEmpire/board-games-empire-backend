import { env, environments } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SystemConfig {
  api_base_url: string;
  encryption_key: string;
  environment: string;
  is_production: boolean;
  port: number;
}

/** What `PORT` falls back to; the root schema compares it with the operational port when `PORT` is unset (#1511). */
export const DEFAULT_PORT = 33333;

export default registerAs('system', () =>
  env.provideMany<SystemConfig>(
    [
      {
        keyTo: 'port',
        key: 'PORT',
        defaultValue: DEFAULT_PORT,
        mutators: [(value: string) => parseInt(value, 10)],
      },
      {
        keyTo: 'api_base_url',
        key: 'API_BASE_URL',
        defaultValue: 'http://localhost',
      },
      {
        keyTo: 'environment',
        key: 'NODE_ENV',
        defaultValue: 'development',
      },
      {
        keyTo: 'encryption_key',
        key: 'DATA_ENCRYPTION_KEY',
        defaultsFor: {
          development: 'development-secret',
          test: 'test-secret',
        },
      },
    ],
    (variables) => ({
      ...variables,
      is_production: env.isProduction,
    }),
  ),
);

/**
 * `DATA_ENCRYPTION_KEY` is optional here for the reason the worker's is: the
 * config above defaults it in development and test, and Joi runs first.
 * `min(10)` is the worker's too, since the two must share the key. `PORT` and
 * the key accept `''`, which `@bge/env` reads as unset.
 */
export const systemConfigValidationSchema = {
  PORT: Joi.number().port().allow(''),
  API_BASE_URL: Joi.string().default('http://localhost'),
  DATA_ENCRYPTION_KEY: Joi.string().min(10).allow(''),
  NODE_ENV: Joi.string()
    .valid(...environments)
    .default('development'),
};
