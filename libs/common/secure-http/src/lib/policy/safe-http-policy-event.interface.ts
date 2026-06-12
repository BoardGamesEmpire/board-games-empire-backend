/**
 * Payload published on the `safe_http.policy_updated` Redis channel after
 * the admin controller persists changes to the `SafeHttpPolicy` singleton
 * row. Every API process subscribes to this channel and triggers a
 * `SafeHttpPolicyService.refresh()` on receipt.
 *
 * Deliberately minimal — the new snapshot is read from the database, not
 * shipped over the pub/sub channel. The database is the source of truth;
 * Redis is the invalidation primitive. This avoids two failure modes:
 *   1. Redis delivering a stale or partial snapshot from a since-superseded
 *      write race.
 *   2. Subscribers diverging from the DB when Redis loses or reorders messages.
 *
 * The publisher is also a subscriber — `redis.publish` delivers to all
 * subscribers including the publishing connection. The refresh handler
 * must be idempotent, which it is: it always reads the current row from DB.
 */
export interface SafeHttpPolicyUpdatedEvent {
  /**
   * ISO-8601 timestamp of the DB write that triggered this event.
   */
  updatedAt: string;

  /**
   * User ID of the admin who made the change, or `null` when system-initiated.
   */
  updatedBy: string | null;
}

export type SafeHttpPolicyEventHandler = (event: SafeHttpPolicyUpdatedEvent) => Promise<void> | void;
