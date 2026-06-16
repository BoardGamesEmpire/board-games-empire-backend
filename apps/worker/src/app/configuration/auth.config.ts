import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface AuthConfig {
  secret: string;
}

export default registerAs('auth', () =>
  env.provideMany<AuthConfig>([
    {
      keyTo: 'secret',
      key: 'BETTER_AUTH_SECRET',
      defaultsFor: {
        development: 'development-secret',
        testing: 'testing-secret',
        staging: 'staging-secret',
      },
    },
  ]),
);

export const authConfigValidationSchema = {
  BETTER_AUTH_SECRET: Joi.string().min(10).required(),
};
