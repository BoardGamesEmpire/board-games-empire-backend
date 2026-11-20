import type { WebhookSubscriptionStatus } from '@bge/database';

/**
 * Emitted exactly once when a subscription transitions out of `Active` due to
 * repeated delivery failure. Only the writer that wins the race-safe
 * conditional update emits it (mirrors `gateway.disabled`), so listeners can
 * treat it as a single source of truth for "this subscription just went down."
 */
export interface WebhookDisabledEvent {
  readonly consecutiveFailures: number;
  readonly createdById: string;
  readonly disabledAt: Date;

  /** Sanitized, static message paired with `lastErrorCode` — never raw error text. */
  readonly lastError: string;

  /**
   * Stable classification (e.g. `TIMEOUT`, `NON_SUCCESS_RESPONSE`) — see
   * `WebhookDeliveryErrorCode` in `@bge/queue-webhooks`. Typed `string` here
   * rather than that enum: this package must not depend on the queue lib.
   */
  readonly lastErrorCode: string;

  readonly status: Extract<WebhookSubscriptionStatus, 'Failed'>;
  readonly subscriptionId: string;
}

/**
 * EventEmitter2 event name emitted once when a subscription auto-disables.
 */
export const WEBHOOK_DISABLED_EVENT = 'webhook.disabled';
