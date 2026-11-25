import type { Prisma } from '@bge/database';
import { InviteStatus, InviteType, liveEventWhere } from '@bge/database';
import { receivedInviteWhere, unexpiredInviteWhere } from '@bge/invites';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/**
 * The event invites open to this user in their inbox (#742): those naming
 * them by id, `Pending`, unexpired, to an event that is live and that they
 * don't attend. By id only: an event invite names its invitee by id, and one
 * sent to an address is #488's, so no address is vouched. A withheld invite
 * never is (#278); the invites lib's filter, `receivedInviteWhere`, leaves it
 * out.
 *
 * Live as every event read judges it (`liveEventWhere`): not deleted, and not
 * in a deleted household (#992). Both deletes revoke the invites to the
 * events they take (#742), so the filter only matters for a delete and an
 * invite create that raced; its accept answers 404 either way.
 *
 * An invite to an event they already attend stays outstanding (an accept of
 * it is refused), so it is hidden rather than offered. A removed attendee's
 * row doesn't count: accepting revives it.
 */
export function receivedEventInviteWhere(userId: string, now: Date): Prisma.InviteWhereInput {
  return {
    type: InviteType.Event,
    AND: [
      receivedInviteWhere(userId),
      { status: InviteStatus.Pending },
      unexpiredInviteWhere(now),
      { event: { is: { ...liveEventWhere(), attendees: { none: { userId, ...NOT_REMOVED } } } } },
    ],
  };
}
