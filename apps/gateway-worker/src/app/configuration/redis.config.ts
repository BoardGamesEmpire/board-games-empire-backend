import { makeRedisConfig } from '@bge/redis';

const { config, validationSchema } = makeRedisConfig({
  namespace: 'redis.cache',
  envPrefix: 'REDIS_',
  database: 0,
});

export default config;
export const redisConfigValidationSchema = validationSchema;
