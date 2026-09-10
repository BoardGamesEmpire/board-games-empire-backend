import { CacheFlushError, type CacheFlush } from './ports';

/** What the flush needs of a client; iovalkey's `Redis` satisfies it. */
export interface FlushClient {
  /** `wait` until the first command on a lazily connecting client; `end` or `close` once closed. */
  readonly status: string;
  scanStream(options: { match: string; count?: number }): AsyncIterable<string[]>;
  unlink(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

/** Keys per SCAN page: a hint to the server, not a bound. Each page of matches is one UNLINK. */
const SCAN_PAGE = 500;

/**
 * The api's cache flush (#236): SCAN each pattern and UNLINK what it yields.
 * The patterns are the physical keys the api's cache store writes, its Keyv
 * namespace in front of the logical key (`api:cache:bge:user:permissions:*`
 * for the ability graphs), composed by the entrypoint that owns both halves.
 * Every graph goes, not the affected users': the plan does not name them, and
 * a deploy is exactly when a stale grant matters. SCAN walks the keyspace by
 * cursor and UNLINK reclaims memory off the command thread, so a large cache
 * blocks neither Valkey nor the boot for long.
 *
 * The client is the flush's own and connects lazily: a boot whose reconcile
 * wrote nothing never opens it, so the sequence's hard dependency stays
 * Postgres and a Redis outage can fail only the flush, which is logged.
 */
export class RedisKeyFlush implements CacheFlush {
  constructor(
    private readonly client: FlushClient,
    private readonly patterns: readonly string[],
  ) {}

  async flush(): Promise<number> {
    let removed = 0;
    for (const pattern of this.patterns) {
      try {
        for await (const page of this.client.scanStream({ match: pattern, count: SCAN_PAGE })) {
          if (page.length === 0) continue;
          removed += await this.client.unlink(...page);
        }
      } catch (error) {
        throw new CacheFlushError(pattern, removed, error);
      }
    }
    return removed;
  }

  /** A client that never connected is dropped without a round trip; one that did is quit so in-flight commands finish. */
  async close(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end' || this.client.status === 'close') {
      this.client.disconnect();
      return;
    }
    await this.client.quit();
  }
}
