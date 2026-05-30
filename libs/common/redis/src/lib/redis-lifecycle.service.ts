import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { Redis } from 'iovalkey';
import { CACHE_REDIS_CLIENT, QUEUE_REDIS_CLIENT } from './redis.tokens';

/**
 * Coordinates graceful shutdown of the shared ioredis clients owned by
 * `RedisModule`.
 *
 * Both clients are injected as `@Optional()` because `RedisModule` allows
 * each connection to be independently configured. A process that only
 * registers the queue connection will have a `null` cache here, and the
 * shutdown logic skips it.
 *
 * On application shutdown the configured clients' `quit()` calls are
 * awaited so any in-flight commands have a chance to complete (rather than
 * `disconnect()` which closes immediately and may interrupt commands in
 * progress).
 *
 * Quits are run concurrently; failures are logged but do not block shutdown.
 */
@Injectable()
export class RedisLifecycleManager implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisLifecycleManager.name);

  constructor(
    @Optional() @Inject(CACHE_REDIS_CLIENT) private readonly cache: Redis | null = null,
    @Optional() @Inject(QUEUE_REDIS_CLIENT) private readonly queue: Redis | null = null,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    const clients: Array<readonly [string, Redis]> = [];
    if (this.cache) clients.push(['cache', this.cache] as const);
    if (this.queue) clients.push(['queue', this.queue] as const);

    if (clients.length === 0) return;

    this.logger.log(
      `Closing shared Redis connections (signal=${signal ?? 'unknown'}, connections=${clients.map(([name]) => name).join(',')})`,
    );

    const results = await Promise.allSettled(clients.map(([name, client]) => this.quitNamed(name, client)));

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Redis client quit failed: ${this.describeError(result.reason)}`);
      }
    }
  }

  private async quitNamed(name: string, client: Redis): Promise<string> {
    // `quit()` rejects if the client is already closed; treat that as success.
    if (client.status === 'end' || client.status === 'close') {
      return name;
    }
    await client.quit();
    return name;
  }

  private describeError(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
