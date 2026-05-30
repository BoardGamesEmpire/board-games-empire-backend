import { QUEUE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

/**
 * Terminus health indicator for the queue Redis connection (BullMQ producer
 * side).
 *
 * Injects `QUEUE_REDIS_CLIENT` as optional — processes that don't configure
 * a queue connection (e.g. a read-only API that doesn't produce jobs) will
 * inject `undefined` and the check reports up with a "not configured"
 * message rather than failing the readiness probe.
 *
 * This validates the *producer-side* connection. BullMQ workers create
 * their own additional blocking connections internally; those are not
 * checked here. Worker availability is a separate operational concern.
 *
 * @see QUEUE_REDIS_CLIENT in @bge/redis
 */
@Injectable()
export class QueueRedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Optional() @Inject(QUEUE_REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  async isHealthy(key = 'queue'): Promise<HealthIndicatorResult> {
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
