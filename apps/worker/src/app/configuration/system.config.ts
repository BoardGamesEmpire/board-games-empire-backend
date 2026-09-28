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

/**
 * `DATA_ENCRYPTION_KEY` is optional here because `defaultsFor` supplies it
 * outside production, and Joi runs first. When it was `required()`, a missing
 * key was rejected before that default could apply, so the worker could not
 * boot without a `.env` (CI, a fresh checkout) although the API, which shares
 * the key, could. Production has no default, so `@bge/env` still refuses to
 * start without a key there. `min(10)` still rejects a key that is set but short.
 */
export const systemConfigValidationSchema = {
  DATA_ENCRYPTION_KEY: Joi.string().min(10),
};
