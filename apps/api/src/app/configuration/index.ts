import Joi from 'joi';
import cache, { cacheConfigValidationSchema } from './cache.config';
import jwt, { jwtConfigValidationSchema } from './jwt.config';
import rabbit from './rabbitmq.config';
import redis, { redisConfigValidationSchema } from './redis.config';
import server, { serverConfigValidationSchema } from './server.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';

export const configuration = {
  cache,
  jwt,
  rabbit,
  redis,
  server,
  swagger,
  throttle,
};

export const configurationValidationSchema = Joi.object({
  ...cacheConfigValidationSchema,
  ...jwtConfigValidationSchema,
  ...redisConfigValidationSchema,
  ...serverConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
});
