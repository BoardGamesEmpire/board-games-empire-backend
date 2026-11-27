import type { HttpResponseLike, RequestDescription } from '../support/wire';
import { envelopeFailure, isRecord } from '../support/wire';

/**
 * Fail-loud parsers for `GET /api/notifications/unread`, the history list
 * `GET /api/notifications` and its `unread/count`, on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a changed shape would otherwise surface as an assertion against
 * `undefined` that names neither the key nor the change.
 */

export interface UnreadNotificationWire {
  readonly id: string;
  readonly payload: Record<string, unknown>;
  readonly type: string;
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

/**
 * One row of `GET /api/notifications`: the unread row's fields, plus whether
 * and when it was read, and when it was written (#1597).
 */
export interface NotificationWire extends UnreadNotificationWire {
  readonly createdAt: string;
  readonly read: boolean;
  readonly readAt: string | null;
}

/** One page of `GET /api/notifications`, its rows and its `pagination` flattened beside them. */
export interface NotificationPageWire {
  readonly hasMore: boolean;
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly notifications: readonly NotificationWire[];
}

/** `{ notifications: [...], pagination: { limit, hasMore, nextCursor } }`, newest first (#1597). */
export function notificationPage(response: HttpResponseLike, request: RequestDescription): NotificationPageWire {
  const body = response.body;
  if (!isRecord(body) || !Array.isArray(body['notifications']) || !isRecord(body['pagination'])) {
    return fail("the body carried no 'notifications' array and 'pagination' object", request, response);
  }

  const { limit, hasMore, nextCursor } = body['pagination'];
  if (
    typeof limit !== 'number' ||
    typeof hasMore !== 'boolean' ||
    (nextCursor !== null && typeof nextCursor !== 'string')
  ) {
    return fail(
      "its pagination carried no number 'limit', boolean 'hasMore' and string-or-null 'nextCursor'",
      request,
      response,
    );
  }

  const notifications = body['notifications'].map((entry: unknown) => {
    if (!isRecord(entry)) {
      return fail('one of its notifications is not an object', request, response);
    }

    const { id, type, payload, read, readAt, createdAt } = entry;
    if (
      typeof id !== 'string' ||
      typeof type !== 'string' ||
      !isRecord(payload) ||
      typeof read !== 'boolean' ||
      (readAt !== null && typeof readAt !== 'string') ||
      typeof createdAt !== 'string'
    ) {
      return fail(
        "one of its notifications carried no string 'id', 'type' and 'createdAt', object 'payload', " +
          "boolean 'read' and string-or-null 'readAt'",
        request,
        response,
      );
    }

    return { id, type, payload, read, readAt, createdAt };
  });

  return { notifications, limit, hasMore, nextCursor };
}

/** `{ count }` from `GET /api/notifications/unread/count` (#1597). */
export function unreadCount(response: HttpResponseLike, request: RequestDescription): number {
  const body = response.body;
  if (!isRecord(body) || typeof body['count'] !== 'number') {
    return fail("the body carried no number 'count'", request, response);
  }

  return body['count'];
}
