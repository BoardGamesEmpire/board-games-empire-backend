import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RAW_REDIS_TOKEN } from './constants/gateway-registry-redis.constants';

/**
 * Thin wrapper around the ioredis client that registers a cleanup hook
 * so the connection is properly closed on application shutdown.
 *
 * Consumers inject the underlying `Redis` instance via `client` rather
 * than this wrapper — only kept around to provide a lifecycle hook.
 */
@Injectable()
export class GatewayRegistryRedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(RAW_REDIS_TOKEN) readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Connection may already be closed — ignore.
    }
  }
}
