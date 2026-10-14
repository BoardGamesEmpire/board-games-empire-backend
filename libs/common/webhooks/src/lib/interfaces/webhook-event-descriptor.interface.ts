import type { WebhookEventMeta, WebhookEventType } from '../constants/webhook-event-types';

/**
 * Static, code-defined metadata for one webhook event type. Pure authorization
 * and routing facts — no payload handling lives here (that comes off the
 * `WebhookEmittableEvent` instance at dispatch), so the descriptor needs no
 * generic and the registry stays a flat, fully-typed map.
 *
 * Its facts are `WebhookEventMeta`'s, documented there, plus the event's own
 * name. Extended rather than restated, so a field added to the table reaches
 * every reader of a descriptor.
 */
export interface WebhookEventDescriptor extends WebhookEventMeta {
  readonly type: WebhookEventType;
}
