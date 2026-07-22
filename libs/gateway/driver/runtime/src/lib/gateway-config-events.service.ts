import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { GATEWAY_CONFIG_UPDATE_CHANNEL } from './constants/gateway-registry.constants';
import type { GatewayConfigEvent } from './interfaces/gateway-config-event.interface';

type ConfigEventHandler = (event: GatewayConfigEvent) => Promise<void> | void;

/**
 * Pub/sub layer for gateway config invalidation. The coordinator publishes
 * when a GameGateway row mutates (config updates, auto-disables, admin
 * reconnects). Every process running GatewayRegistryService subscribes
 * to invalidate cached clients.
 *
 * Uses the shared cache Redis client (`CACHE_REDIS_CLIENT` from `@bge/redis`).
 * The cache database is the right home for this pub/sub channel — invalidation
 * events live alongside the cached state they invalidate, and both can be
 * `FLUSHDB`'d together without affecting queue or socket state.
 *
 * The subscribe path requires connection isolation (ioredis blocks other
 * commands in subscribe mode), so `subscribe()` calls `client.duplicate()`
 * to get a dedicated subscriber connection. The duplicate is owned and
 * closed by this service; the shared cache client is owned elsewhere.
 */
@Injectable()
export class GatewayConfigEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(GatewayConfigEventsService.name);
  private subscriberConnection?: Redis;

  constructor(@Inject(CACHE_REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    if (this.subscriberConnection) {
      try {
        await this.subscriberConnection.unsubscribe(GATEWAY_CONFIG_UPDATE_CHANNEL);
        await this.subscriberConnection.quit();
      } catch (err) {
        this.logger.warn(`Error during pub/sub cleanup: ${err instanceof Error ? err.message : err}`);
      }

      this.subscriberConnection = undefined;
    }
  }

  /**
   * Publishes a config-update event to subscribed processes. Called by the
   * coordinator after persisting changes to a GameGateway row, and by any
   * process auto-disabling a gateway due to repeated failures.
   */
  async publish(event: GatewayConfigEvent): Promise<void> {
    try {
      await this.redis.publish(GATEWAY_CONFIG_UPDATE_CHANNEL, JSON.stringify(event));
      this.logger.debug(`Published ${event.changeType} for gateway ${event.gatewayId} (hash=${event.configHash})`);
    } catch (err) {
      this.logger.error(
        `Failed to publish config event for gateway ${event.gatewayId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Subscribes to config-update events. Returns an unsubscribe function
   * for the caller to invoke on module destroy. Only one subscription is
   * supported per service instance.
   */
  async subscribe(handler: ConfigEventHandler): Promise<() => Promise<void>> {
    if (this.subscriberConnection) {
      throw new Error('GatewayConfigEventsService already has an active subscription');
    }

    this.subscriberConnection = this.redis.duplicate();

    await this.subscriberConnection.subscribe(GATEWAY_CONFIG_UPDATE_CHANNEL);

    this.subscriberConnection.on('message', async (channel, message) => {
      if (channel !== GATEWAY_CONFIG_UPDATE_CHANNEL) return;

      try {
        const event = JSON.parse(message) as GatewayConfigEvent;
        await handler(event);
      } catch (err) {
        this.logger.error(`Failed to handle config update message: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.logger.log(`Subscribed to ${GATEWAY_CONFIG_UPDATE_CHANNEL}`);

    return async () => {
      await this.onModuleDestroy();
    };
  }
}
