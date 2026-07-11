import { makeRedisConfig } from '@bge/redis';

const { config, validationSchema } = makeRedisConfig({
  namespace: 'redis.queue',
  envPrefix: 'REDIS_BULLMQ_',
  database: 2,
});

export default config;
export const redisConfigValidationSchema = validationSchema;
