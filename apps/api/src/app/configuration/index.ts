import { authConfigValidationSchema } from '@bge/auth';
import { coordinatorClientConfigValidationSchema } from '@bge/coordinator';
import { healthConfigValidationSchema } from '@bge/health';
import { prometheusConfigValidationSchema } from '@bge/metrics';
import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import { bgeIdentityConfigValidationSchema, securityTxtConfigValidationSchema } from '@bge/well-known';
import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import plugins, { pluginsConfigValidationSchema } from './plugins.config';
import redisBullmq, { redisQueueConfigValidationSchema } from './redis-queue.config';
import redisWebsocket, { redisWebsocketConfigValidationSchema } from './redis-sockets.config';
import redis, { redisConfigValidationSchema } from './redis.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import system, { systemConfigValidationSchema } from './system.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';
export { API_CACHE_NAMESPACE } from './cache.config';

export const configuration = {
  cache,
  mediaConfig,
  plugins,
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
  ...pluginsConfigValidationSchema,
  ...prometheusConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisQueueConfigValidationSchema,
  ...securityTxtConfigValidationSchema,
  ...systemConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
  ...redisWebsocketConfigValidationSchema,
});
