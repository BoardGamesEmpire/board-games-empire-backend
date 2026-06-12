import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SAFE_HTTP_POLICY_UPDATE_CHANNEL } from '../constants/safe-http.constants';
import type { SafeHttpPolicyEventHandler, SafeHttpPolicyUpdatedEvent } from './safe-http-policy-event.interface';

/**
 * Cross-process invalidation for the `SafeHttpPolicy` snapshot. The admin
 * controller publishes after persisting to DB; every API process subscribes
 * and refreshes its in-memory snapshot.
 *
 * Uses the shared cache Redis client (`CACHE_REDIS_CLIENT`). The cache
 * database is the right home — invalidation events live alongside the
 * cached state they invalidate, and both can be `FLUSHDB`'d together
 * without affecting queue or socket state. This matches the placement of
 * `GatewayConfigEventsService`.
 *
 * ioredis subscribe mode blocks other commands on the same connection, so
 * `subscribe()` calls `.duplicate()` to obtain a dedicated subscriber
 * connection owned by this service. The shared cache client remains
 * available for `publish()` and is owned by `@bge/redis`.
 */
@Injectable()
export class SafeHttpPolicyEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(SafeHttpPolicyEventsService.name);
  private subscriberConnection?: Redis;

  constructor(@Inject(CACHE_REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriberConnection) return;

    try {
      await this.subscriberConnection.unsubscribe(SAFE_HTTP_POLICY_UPDATE_CHANNEL);
      await this.subscriberConnection.quit();
    } catch (err) {
      this.logger.warn(`Error during pub/sub cleanup: ${err instanceof Error ? err.message : err}`);
    }

    this.subscriberConnection = undefined;
  }

  /**
   * Publish a policy-update notification to all subscribed processes. Called
   * by the admin controller after committing the DB write. Failure here is
   * logged but not thrown — the DB row is the source of truth, and a missed
   * notification means subscribers stay on the prior snapshot until the next
   * event. Better than crashing the admin request.
   */
  async publish(event: SafeHttpPolicyUpdatedEvent): Promise<void> {
    try {
      await this.redis.publish(SAFE_HTTP_POLICY_UPDATE_CHANNEL, JSON.stringify(event));
      this.logger.debug(`Published policy update (updatedBy=${event.updatedBy ?? 'system'})`);
    } catch (err) {
      this.logger.error(`Failed to publish policy update: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Subscribe to policy-update events. Returns an unsubscribe function for
   * the caller to invoke on module destroy. Only one subscription per
   * service instance — calling twice throws.
   *
   * The handler is invoked on every received message including those
   * published by the local process. Handlers must be idempotent.
   */
  async subscribe(handler: SafeHttpPolicyEventHandler): Promise<() => Promise<void>> {
    if (this.subscriberConnection) {
      throw new Error('SafeHttpPolicyEventsService already has an active subscription');
    }

    this.subscriberConnection = this.redis.duplicate();
    await this.subscriberConnection.subscribe(SAFE_HTTP_POLICY_UPDATE_CHANNEL);

    this.subscriberConnection.on('message', async (channel, message) => {
      if (channel !== SAFE_HTTP_POLICY_UPDATE_CHANNEL) return;

      try {
        const event = JSON.parse(message) as SafeHttpPolicyUpdatedEvent;
        await handler(event);
      } catch (err) {
        this.logger.error(`Failed to handle policy update message: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.logger.log(`Subscribed to ${SAFE_HTTP_POLICY_UPDATE_CHANNEL}`);

    return async () => {
      await this.onModuleDestroy();
    };
  }
}
