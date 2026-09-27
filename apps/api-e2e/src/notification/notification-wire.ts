import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parser for `GET /api/notifications/unread`, on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a changed shape would otherwise surface as an assertion against
 * `undefined` that names neither the key nor the change.
 */

export interface UnreadNotificationWire {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const fail = envelopeFailure('apps/api-e2e/src/notification/notification-wire.ts');

/** A bare array of `{ id, type, payload, read, createdAt }`, newest first. */
export function unreadNotifications(
  response: HttpResponseLike,
  request: RequestDescription,
): readonly UnreadNotificationWire[] {
  if (!Array.isArray(response.body)) {
    return fail('the body is not an array', request, response);
  }

  return response.body.map((entry: unknown) => {
    if (!isRecord(entry)) {
      return fail('one of its entries is not an object', request, response);
    }

    const { id, type, payload } = entry;
    if (typeof id !== 'string' || typeof type !== 'string' || !isRecord(payload)) {
      return fail("one of its entries carried no string 'id', string 'type' and object 'payload'", request, response);
    }

    return { id, type, payload };
  });
}
