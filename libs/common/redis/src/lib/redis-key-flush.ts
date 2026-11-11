/**
 * A flush that could not finish: the pattern it stopped on and how many keys
 * had already gone, so the log can say which half of the cache is still there
 * rather than that nothing was touched.
 */
export class CacheFlushError extends Error {
  constructor(
    readonly pattern: string,
    readonly removed: number,
    readonly reason: unknown,
  ) {
    super(
      `Cache flush failed on '${pattern}' after removing ${removed} key(s): ` +
        (reason instanceof Error ? reason.message : String(reason)),
    );
    this.name = 'CacheFlushError';
  }
}

/** What the flush needs of a client; iovalkey's `Redis` satisfies it. */
export interface FlushClient {
  scanStream(options: { match: string; count?: number }): AsyncIterable<string[]>;
  unlink(...keys: string[]): Promise<number>;
  disconnect(): void;
}

/** Keys per SCAN page: a hint to the server, not a bound. Each page of matches is one UNLINK. */
const SCAN_PAGE = 500;

/**
 * Removes every key matching each pattern: SCAN the pattern and UNLINK what it
 * yields. SCAN walks the keyspace by cursor and UNLINK reclaims memory off the
 * command thread, so a large cache blocks neither Valkey nor its caller for
 * long. The patterns are the physical keys the permissions cache writes, its
 * prefix and namespace in front of the logical key (for the ability graphs,
 * `namespace:permissions:cache:bge:user:permissions:*`).
 *
 * It has two callers, which differ in the client they hand it:
 *
 * - The boot sequence's flush after a reconcile of the permission catalog
 *   that wrote rows, or a data migration that applied (#236), composed by
 *   `BootstrapModule`. It satisfies bootstrap's `CacheFlush` port
 *   structurally, since this lib cannot import that port. The client is the
 *   flush's own and connects lazily, so a boot whose reconcile wrote nothing
 *   never opens it, the sequence's hard dependency stays Postgres, and a
 *   Redis outage can fail only the flush, which is logged. The sequence
 *   calls `close` when it is over.
 * - `PermissionsService.invalidateAllGraphs`, after an edit of the permission
 *   catalog commits at runtime (#772). Its client is the shared
 *   `CACHE_REDIS_CLIENT` every reader of the cache uses, so it never calls
 *   `close`.
 *
 * Either way every graph goes, not the affected users': neither a
 * reconcile's plan nor an edit names them, and both are exactly when a stale
 * grant matters.
 */
export class RedisKeyFlush {
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
