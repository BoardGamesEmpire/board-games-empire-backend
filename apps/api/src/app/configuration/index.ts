import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import jwt, { jwtConfigValidationSchema } from './jwt.config';
import redisBullmq, { redisConfigValidationSchema as redisBullmqConfigValidationSchema } from './redis-queue.config';
import redisWebsocket, { redisWebsocketConfigValidationSchema } from './redis-sockets.config';
import redis, { redisConfigValidationSchema } from './redis.config';
import server, { serverConfigValidationSchema } from './server.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';

export const configuration = {
  cache,
  jwt,
  redis,
  redisBullmq,
  redisWebsocket,
  server,
  swagger,
  throttle,
};

export const configurationValidationSchema = Joi.object({
  ...cacheConfigValidationSchema,
  ...jwtConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...redisBullmqConfigValidationSchema,
  ...serverConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
  ...redisWebsocketConfigValidationSchema,
});
