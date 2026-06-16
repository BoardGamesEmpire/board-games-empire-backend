import type { Actor } from '@bge/actor-context';
import type { WebhookEventType } from '@bge/webhooks';

/**
 * One delivery job = one (event, subscription) pair. Fully self-contained: the
 * dispatcher resolves and freezes everything here at enqueue, because the
 * delivery processor runs in the worker — outside the CLS scope that produced
 * the event — and must not re-read request context.
 *
 * `actor` is captured from CLS at enqueue (the originator of the underlying
 * mutation) and carried verbatim; it is informational for the receiver's
 * payload, not re-authorized at delivery (authorization already happened at
 * dispatch via the subscriber's read ability).
 */
export interface WebhookDeliveryJob {
  /**
   * Unique per delivery; surfaces as `X-BGE-Delivery-Id` and the idempotency key.
   */
  readonly deliveryId: string;

  readonly subscriptionId: string;

  readonly eventType: WebhookEventType;

  /**
   * Subject record the event concerned (for logging/idempotency, not re-auth).
   */
  readonly subjectId: string;

  /**
   * Actor that triggered the originating mutation, lifted from CLS at enqueue.
   */
  readonly actor: Actor;

  /**
   * The signed/POSTed body. Already PII-filtered by the emit site.
   */
  readonly payload: WebhookDeliveryEnvelope;
}

/**
 * The JSON body delivered to the receiver. The signature covers its serialization.
 */
export interface WebhookDeliveryEnvelope {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly occurredAt: string;
  readonly subjectId: string;
  readonly data: unknown;
}
