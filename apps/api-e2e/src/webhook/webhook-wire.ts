import type { WebhookSubscription } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the webhook subscription envelopes, on the pattern
 * `household/household-wire.ts` sets.
 */

export type WebhookSubscriptionWire = Wire<WebhookSubscription>;

const fail = envelopeFailure('apps/api-e2e/src/webhook/webhook-wire.ts');

/** `POST /api/webhooks/subscriptions`: `{ message, subscription }`. */
export function subscriptionEnvelope(response: HttpResponseLike, request: RequestDescription): WebhookSubscriptionWire {
  const subscription = isRecord(response.body) ? response.body['subscription'] : undefined;

  return isRecord(subscription) && typeof subscription['id'] === 'string'
    ? (subscription as WebhookSubscriptionWire)
    : fail("it carried no 'subscription' object with a string id", request, response);
}
