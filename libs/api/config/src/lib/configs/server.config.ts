import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { env } from './env';

export interface ServerConfig {
  is_production: boolean;
  environment: string;
  port: number;
  api_base_url: string;
}

export default registerAs('server', () =>
  env.provideMany<ServerConfig>(
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
    ],
    (variables) => ({
      ...variables,
      is_production: env.isProduction,
    }),
  ),
);

export const serverConfigValidationSchema = {
  SERVER_PORT: Joi.number().default(33333),
  API_BASE_URL: Joi.string().default('http://localhost'),
};
