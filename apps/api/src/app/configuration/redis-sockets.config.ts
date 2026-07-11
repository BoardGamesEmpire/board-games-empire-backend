import { makeRedisConfig } from '@bge/redis';

const { config, validationSchema } = makeRedisConfig({
  namespace: 'redis.websocket',
  envPrefix: 'REDIS_WEBSOCKET_',
  database: 1,
});

export default config;
export const redisWebsocketConfigValidationSchema = validationSchema;
