import { env, environments } from '@bge/env';
import type { ConfigModuleOptions } from '@nestjs/config';
import Joi from 'joi';
import coordinatorConfig, { coordinatorConfigValidationSchema } from './coordinator.config';
import redisQueueConfig, { redisQueueConfigValidationSchema } from './redis-queue.config';
import redisConfig, { redisConfigValidationSchema } from './redis.config';

export const configuration = {
  coordinator: coordinatorConfig,
  redisQueue: redisQueueConfig,
  redis: redisConfig,
};

export const configurationValidationSchema = Joi.object({
  ...coordinatorConfigValidationSchema,
  ...redisQueueConfigValidationSchema,
  ...redisConfigValidationSchema,
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
    // Names every invalid variable in one message.
    abortEarly: false,
    cache: !env.isProduction,
    debug: !env.isProduction,
    stack: !env.isProduction,
  },
} satisfies ConfigModuleOptions;
