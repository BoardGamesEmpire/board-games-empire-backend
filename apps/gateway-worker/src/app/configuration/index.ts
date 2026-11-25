import { coordinatorClientConfigValidationSchema } from '@bge/coordinator';
import { env, environments } from '@bge/env';
import type { ConfigModuleOptions } from '@nestjs/config';
import Joi from 'joi';
import redisBullmq, { redisConfigValidationSchema as redisBullmqConfigValidationSchema } from './redis-queue.config';
import redis, { redisConfigValidationSchema } from './redis.config';

export const configuration = {
  redis,
  redisBullmq,
};

export const configurationValidationSchema = Joi.object({
  ...redisConfigValidationSchema,
  ...redisBullmqConfigValidationSchema,
  // The coordinator's address, which the plugin gateway relay loads with
  // `forFeature` and so leaves unvalidated (#1083).
  ...coordinatorClientConfigValidationSchema,
  // Only the environments `@bge/env` knows: under any other name, no
  // per-environment default applies (#290).
  NODE_ENV: Joi.string().valid(...environments),
});

/** The root module's `ConfigModule.forRoot` options, which `required-configuration.spec.ts` checks too. */
export const configModuleOptions = {
  load: Object.values(configuration),
  cache: true,
  isGlobal: true,
  expandVariables: true,
  validationSchema: configurationValidationSchema,
  validationOptions: {
    // Joi reads its own options from `libraryOptions`.
    libraryOptions: {
      // Names every invalid variable in one message.
      abortEarly: false,
      cache: !env.isProduction,
      debug: !env.isProduction,
      stack: !env.isProduction,
    },
  },
} satisfies ConfigModuleOptions;
