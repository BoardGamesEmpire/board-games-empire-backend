import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

/**
 * Terminus health indicator for the cache Redis connection.
 *
 * Injects `CACHE_REDIS_CLIENT` as optional — processes that don't configure
 * a cache connection (e.g. a queue-only worker that still loads HealthModule)
 * will inject `undefined` and the check reports up with a "not configured"
 * message rather than failing the readiness probe.
 *
 * @see CACHE_REDIS_CLIENT in @bge/redis
 */
@Injectable()
export class CacheRedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Optional() @Inject(CACHE_REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async isHealthy(key = 'cache'): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    if (!this.redis) {
      return indicator.up({ message: 'not configured' });
    }

    try {
      const response = await this.redis.ping();

      if (response !== 'PONG') {
        return indicator.down({ message: `Unexpected PING response: ${response}` });
      }

      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return indicator.down({ message });
    }
  }
}
