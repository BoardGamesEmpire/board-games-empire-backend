/**
 * Injection token for the shared cache Redis client.
 *
 * Used by:
 *   - `CacheModule` (via @keyv/valkey adapter)
 *   - `GatewayConfigEventsModule` (pub/sub on the same logical database)
 *   - `HealthModule` (Redis health indicator)
 *
 * Connects to the database configured by `redis.cache` (env: REDIS_DATABASE).
 *
 * Only registered if `RedisModule.forRootAsync` was configured with a `cache`
 * connection. Injecting this token when cache was not configured produces a
 * standard NestJS "no provider found" error at module init.
 *
 * @see docs/REDIS.md
 */
export const CACHE_REDIS_CLIENT = Symbol('CACHE_REDIS_CLIENT');

/**
 * Injection token for the shared BullMQ producer Redis client.
 *
 * Passed to BullMQ `Queue` and `FlowProducer` constructors. Workers always
 * create their own additional blocking connection (BRPOP) regardless — that
 * connection is not, and cannot be, shared.
 *
 * Configured with `maxRetriesPerRequest: null` as required by BullMQ.
 *
 * Connects to the database configured by `redis.queue` (env: REDIS_BULLMQ_DATABASE).
 *
 * Only registered if `RedisModule.forRootAsync` was configured with a `queue`
 * connection. Injecting this token when queue was not configured produces a
 * standard NestJS "no provider found" error at module init.
 *
 * @see docs/REDIS.md
 */
export const QUEUE_REDIS_CLIENT = Symbol('QUEUE_REDIS_CLIENT');
