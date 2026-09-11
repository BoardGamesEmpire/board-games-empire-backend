import { CacheFlushError, type CacheFlush } from './ports';

/** What the flush needs of a client; iovalkey's `Redis` satisfies it. */
export interface FlushClient {
  scanStream(options: { match: string; count?: number }): AsyncIterable<string[]>;
  unlink(...keys: string[]): Promise<number>;
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

  /**
   * Closes the socket without a round trip. `flush` awaits every command it
   * sends, so by the time the sequence closes the flush nothing is in flight
   * and a QUIT would buy nothing; what it could do is wait. After a flush the
   * outage failed, the client is reconnecting, and a QUIT queued behind that
   * is rejected when the retries run out, which would turn a tolerated outage
   * into a boot failure in the sequence's `finally`. Dropping the socket never
   * waits on Redis and never rejects.
   */
  async close(): Promise<void> {
    this.client.disconnect();
  }
}
