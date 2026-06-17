import type { WebhookSubscriptionStatus } from '@bge/database';

/**
 * Emitted exactly once when a subscription transitions out of `Active` due to
 * repeated delivery failure. Only the writer that wins the race-safe
 * conditional update emits it (mirrors `gateway.disabled`), so listeners can
 * treat it as a single source of truth for "this subscription just went down."
 */
export interface WebhookDisabledEvent {
  readonly subscriptionId: string;
  readonly createdById: string;
  readonly status: Extract<WebhookSubscriptionStatus, 'Failed'>;
  readonly consecutiveFailures: number;
  readonly lastError: string;
  readonly disabledAt: Date;
}

/**
 * EventEmitter2 event name emitted once when a subscription auto-disables.
 */
export const WEBHOOK_DISABLED_EVENT = 'webhook.disabled';
