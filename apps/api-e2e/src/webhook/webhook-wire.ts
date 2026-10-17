import type { WebhookSubscription } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the webhook subscription envelopes, on the pattern
 * `household/household-wire.ts` sets.
 */

export type WebhookSubscriptionWire = Wire<WebhookSubscription>;

const fail = envelopeFailure('apps/api-e2e/src/webhook/webhook-wire.ts');

/**
 * `POST /api/webhooks/subscriptions` and `PATCH …/:id`: `{ message, subscription }`.
 * `GET …/:id`: `{ subscription }`.
 */
export function subscriptionEnvelope(response: HttpResponseLike, request: RequestDescription): WebhookSubscriptionWire {
  const subscription = isRecord(response.body) ? response.body['subscription'] : undefined;

  return isRecord(subscription) && typeof subscription['id'] === 'string'
    ? (subscription as WebhookSubscriptionWire)
    : fail("it carried no 'subscription' object with a string id", request, response);
}

/** `GET /api/webhooks/subscriptions`: a bare `{ subscriptions: [...] }`, with no pagination envelope. */
export function listSubscriptionsEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): readonly WebhookSubscriptionWire[] {
  const subscriptions = isRecord(response.body) ? response.body['subscriptions'] : undefined;

  if (!Array.isArray(subscriptions)) {
    return fail("it carried no 'subscriptions' array", request, response);
  }

  if (!subscriptions.every((entry) => isRecord(entry) && typeof entry['id'] === 'string')) {
    return fail('one of its subscriptions is not an object with a string id', request, response);
  }

  return subscriptions as WebhookSubscriptionWire[];
}
