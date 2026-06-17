import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SystemConfig {
  api_base_url: string;
  encryption_key: string;
  environment: string;
  is_production: boolean;
  port: number;
}

export default registerAs('system', () =>
  env.provideMany<SystemConfig>(
    [
      {
        keyTo: 'port',
        key: 'SERVER_PORT',
        defaultValue: 33333,
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
          testing: 'testing-secret',
          staging: 'staging-secret',
        },
      },
    ],
    (variables) => ({
      ...variables,
      is_production: env.isProduction,
    }),
  ),
);

export const systemConfigValidationSchema = {
  SERVER_PORT: Joi.number().default(33333),
  API_BASE_URL: Joi.string().default('http://localhost'),
  DATA_ENCRYPTION_KEY: Joi.string().default(''),
  NODE_ENV: Joi.string().valid('development', 'testing', 'staging', 'production').default('development'),
};
