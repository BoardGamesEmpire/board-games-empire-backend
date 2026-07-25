import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PLUGIN_CONFIG_UPDATE_CHANNEL } from './plugin-config.constants';

/** Message published after a plugin's server-scope config commit. */
export interface PluginConfigReloadEvent {
  readonly slug: string;
}

export type PluginConfigReloadHandler = (event: PluginConfigReloadEvent) => void | Promise<void>;

/**
 * Cross-process invalidation for per-plugin config snapshots. Mirrors
 * `SafeHttpPolicyEventsService` deliberately — same connection tier (cache
 * client), same publish-on-mutation / subscribe-and-reload shape, same
 * failure semantics (publish failures are logged, never thrown: the DB row
 * is the source of truth and a missed notification means subscribers stay
 * on the prior snapshot until the interval backstop).
 *
 * ioredis subscribe mode blocks other commands on the same connection, so
 * `subscribe()` calls `.duplicate()` for a dedicated subscriber connection
 * owned by this service.
 */
@Injectable()
export class PluginConfigEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(PluginConfigEventsService.name);
  private subscriberConnection?: Redis;

  constructor(@Inject(CACHE_REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    const connection = this.subscriberConnection;
    if (!connection) return;

    this.subscriberConnection = undefined;

    // Separate try blocks: a rejecting unsubscribe (Redis already gone)
    // must not skip quit() and leak the duplicated connection.
    try {
      await connection.unsubscribe(PLUGIN_CONFIG_UPDATE_CHANNEL);
    } catch (err) {
      this.logger.warn(`Error unsubscribing during cleanup: ${err instanceof Error ? err.message : err}`);
    }

    try {
      await connection.quit();
    } catch (err) {
      this.logger.warn(`Error closing subscriber connection: ${err instanceof Error ? err.message : err}`);
    }
  }

  async publish(event: PluginConfigReloadEvent): Promise<void> {
    try {
      await this.redis.publish(PLUGIN_CONFIG_UPDATE_CHANNEL, JSON.stringify(event));
      this.logger.debug(`Published config reload for plugin '${event.slug}'`);
    } catch (err) {
      this.logger.error(`Failed to publish config reload: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Subscribe to config-reload events. One subscription per service
   * instance — calling twice throws. The handler runs for every message
   * including locally published ones; handlers must be idempotent.
   */
  async subscribe(handler: PluginConfigReloadHandler): Promise<() => Promise<void>> {
    if (this.subscriberConnection) {
      throw new Error('PluginConfigEventsService already has an active subscription');
    }

    const connection = this.redis.duplicate();

    // Attached BEFORE subscribing so no message can land in the window
    // between the subscription taking effect and the listener existing.
    connection.on('message', (channel: string, message: string) => {
      if (channel !== PLUGIN_CONFIG_UPDATE_CHANNEL) return;

      void (async (): Promise<void> => {
        try {
          const event = JSON.parse(message) as PluginConfigReloadEvent;

          if (typeof event.slug !== 'string' || event.slug.length === 0) {
            this.logger.error(`Malformed config reload message dropped: ${message}`);
            return;
          }

          await handler(event);
        } catch (err) {
          this.logger.error(`Failed to handle config reload message: ${err instanceof Error ? err.message : err}`);
        }
      })();
    });

    try {
      await connection.subscribe(PLUGIN_CONFIG_UPDATE_CHANNEL);
    } catch (err) {
      // A failed subscribe must not leave the instance stuck: without this
      // the field would stay set and every retry would report an active
      // subscription that does not exist. Discard the dead connection and
      // let the caller decide whether to retry.
      await connection.quit().catch(() => undefined);
      throw err;
    }

    // Only now is the subscription real — publish the field last.
    this.subscriberConnection = connection;

    this.logger.log(`Subscribed to ${PLUGIN_CONFIG_UPDATE_CHANNEL}`);

    return async () => {
      await this.onModuleDestroy();
    };
  }
}
