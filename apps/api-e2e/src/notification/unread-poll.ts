import { pollUntil, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { unreadNotifications, type UnreadNotificationWire } from './notification-wire';

const UNREAD_PATH = '/api/notifications/unread';

/**
 * Polls `GET /api/notifications/unread` as `actor` until `predicate` holds,
 * and answers the list it held of. A notification listener runs after the
 * response to the request that caused it (#167), so one read straight after
 * that request can come too early. It waits as long as every other poll in
 * the suite does, `pollUntil`'s default.
 *
 * Nothing here waits out an absence. A spec showing that a notification was
 * NOT sent waits instead for a later one the same user is sent, then checks
 * the list: a fixed sleep would pass just as well if the listener never ran.
 *
 * On timeout it throws with the last list it read, so the failure shows what
 * did arrive rather than only what did not.
 */
export async function unreadWhen(
  baseUrl: string,
  actor: SessionActor,
  predicate: (unread: readonly UnreadNotificationWire[]) => boolean,
): Promise<readonly UnreadNotificationWire[]> {
  let last: readonly UnreadNotificationWire[] = [];

  return pollUntil(
    async () => {
      const response = await request(baseUrl).get(UNREAD_PATH).set(actor.headers).expect(200);
      last = unreadNotifications(response, `GET ${UNREAD_PATH}`);

      return predicate(last) ? last : undefined;
    },
    {
      description: () =>
        `user '${actor.user.username}' (${actor.user.id}) to hold the notifications the spec expects. ` +
        `Their last unread list was:\n${JSON.stringify(last, null, 2)}`,
    },
  );
}
