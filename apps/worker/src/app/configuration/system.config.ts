import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SystemConfig {
  encryption_key: string;
}

export default registerAs('system', () =>
  env.provideMany<SystemConfig>([
    {
      keyTo: 'encryption_key',
      key: 'DATA_ENCRYPTION_KEY',
      defaultsFor: {
        development: 'development-secret',
        testing: 'testing-secret',
        staging: 'staging-secret',
      },
    },
  ]),
);

export const systemConfigValidationSchema = {
  DATA_ENCRYPTION_KEY: Joi.string().min(10).required(),
};
