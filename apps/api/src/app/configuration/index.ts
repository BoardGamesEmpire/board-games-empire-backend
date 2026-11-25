import { authConfigValidationSchema } from '@bge/auth';
import { coordinatorClientConfigValidationSchema } from '@bge/coordinator';
import { env } from '@bge/env';
import { healthConfigValidationSchema } from '@bge/health';
import { prometheusConfigValidationSchema } from '@bge/metrics';
import { pluginsConfig, pluginsConfigValidationSchema } from '@bge/plugin';
import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import { bgeIdentityConfigValidationSchema, securityTxtConfigValidationSchema } from '@bge/well-known';
import type { ConfigModuleOptions } from '@nestjs/config';
import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import operational, { DEFAULT_OPERATIONAL_PORT, operationalConfigValidationSchema } from './operational.config';
import redisBullmq, { redisQueueConfigValidationSchema } from './redis-queue.config';
import redisWebsocket, { redisWebsocketConfigValidationSchema } from './redis-sockets.config';
import redis, { redisConfigValidationSchema } from './redis.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import system, { DEFAULT_PORT, systemConfigValidationSchema } from './system.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';
export { API_CACHE_NAMESPACE } from './cache.config';

export const configuration = {
  cache,
  mediaConfig,
  operational,
  plugins: pluginsConfig,
  redis,
  redisBullmq,
  redisWebsocket,
  system,
  swagger,
  throttle,
};

/**
 * Every variable the api reads, from its own configs and from those its
 * modules load with `forFeature`, which validates nothing. The database's are
 * validated by the bootstrap's own `ConfigModule` (`BootstrapModule`).
 */
export const configurationValidationSchema = Joi.object({
  ...authConfigValidationSchema,
  ...bgeIdentityConfigValidationSchema,
  ...cacheConfigValidationSchema,
  ...coordinatorClientConfigValidationSchema,
  ...healthConfigValidationSchema,
  ...mediaConfigValidationSchema,
  ...operationalConfigValidationSchema,
  ...pluginsConfigValidationSchema,
  ...prometheusConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisQueueConfigValidationSchema,
  ...securityTxtConfigValidationSchema,
  ...systemConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
  ...redisWebsocketConfigValidationSchema,
}).custom((variables, helpers) => {
  // Joi has converted both to numbers by now; only an absent or empty one is
  // unset, and takes its default as the configs do. A 0 is a port, not unset.
  // An invalid one already failed above.
  const isUnset = (value: unknown) => value === undefined || value === '';
  const port = isUnset(variables.PORT) ? DEFAULT_PORT : Number(variables.PORT);
  const operationalPort = isUnset(variables.OPERATIONAL_PORT)
    ? DEFAULT_OPERATIONAL_PORT
    : Number(variables.OPERATIONAL_PORT);

  // Two listeners on one port would fail at listen with EADDRINUSE, after the
  // rest of boot (#1511).
  return port === operationalPort
    ? helpers.message({
        custom: `OPERATIONAL_PORT must differ from PORT, and both are ${port}. Set OPERATIONAL_PORT, or PORT, to another port`,
      })
    : variables;
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
