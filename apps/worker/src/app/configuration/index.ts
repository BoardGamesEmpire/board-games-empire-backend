import { env, environments } from '@bge/env';
import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import type { ConfigModuleOptions } from '@nestjs/config';
import Joi from 'joi';
import redisCache, { redisCacheValidationSchema } from './redis-cache.config';
import redis, { redisConfigValidationSchema } from './redis-queue.config';
import system, { systemConfigValidationSchema } from './system.config';

export const configuration = {
  mediaConfig,
  redis,
  redisCache,
  system,
};

export const configurationValidationSchema = Joi.object({
  ...mediaConfigValidationSchema,
  ...redisCacheValidationSchema,
  ...redisConfigValidationSchema,
  ...systemConfigValidationSchema,
  // Only the environments `@bge/env` knows: under any other name, no
  // per-environment default applies (#290).
  NODE_ENV: Joi.string().valid(...environments),
});

/** The root module's `ConfigModule.forRoot` options, which `required-configuration.spec.ts` checks too. */
export const configModuleOptions = {
  load: Object.values(configuration),
  envFilePath: env.isProduction ? undefined : '.env',
  cache: true,
  isGlobal: true,
  expandVariables: true,
  validationSchema: configurationValidationSchema,
  validationOptions: {
    // Names every invalid variable in one message.
    abortEarly: false,
    cache: !env.isProduction,
    debug: !env.isProduction,
    stack: !env.isProduction,
  },
} satisfies ConfigModuleOptions;
