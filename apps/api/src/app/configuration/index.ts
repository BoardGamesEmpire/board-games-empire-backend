import { mediaConfig, mediaConfigValidationSchema } from '@bge/storage';
import { bgeIdentityConfigValidationSchema } from '@bge/well-known';
import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import redisBullmq, { redisQueueConfigValidationSchema } from './redis-queue.config';
import redisWebsocket, { redisWebsocketConfigValidationSchema } from './redis-sockets.config';
import redis, { redisConfigValidationSchema } from './redis.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import system, { systemConfigValidationSchema } from './system.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';

export const configuration = {
  cache,
  mediaConfig,
  redis,
  redisBullmq,
  redisWebsocket,
  system,
  swagger,
  throttle,
};

export const configurationValidationSchema = Joi.object({
  ...bgeIdentityConfigValidationSchema,
  ...cacheConfigValidationSchema,
  ...mediaConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisQueueConfigValidationSchema,
  ...systemConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
  ...redisWebsocketConfigValidationSchema,
});
