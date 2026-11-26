import type { InviteStatus, Prisma } from '@bge/database';
import { InviteType, liveEventWhere } from '@bge/database';
import {
  effectiveInviteStatusWhere,
  LISTED_BY_DEFAULT_INVITE_STATUSES,
  OUTSTANDING_INVITE_STATUSES,
  unexpiredInviteWhere,
} from '@bge/invites';
import { NOT_REMOVED } from '../constants/not-removed.constant';

/**
 * The event invites this user has sent (#742): how an attendee who invited
 * finds their invites, since only the host and co-host read the event's
 * list.
 *
 * By default, the invites still open and those that expired; `status` picks
 * any one status as it stands now, as the event's list does. The list reports
 * each row's status as it stands now, so an outstanding row past its date
 * reads `Expired`.
 *
 * To an event the inviter doesn't attend, only the invites they can still
 * withdraw are listed, outstanding and unexpired, whatever the filter asks: a
 * household owner or admin may invite to the household's events without a
 * seat on them. A removed attendee has nothing left to withdraw there, since
 * the removal revoked it, and a settled invite there would go on telling
 * them who joined. An invite to an event that isn't live (`liveEventWhere`,
 * #992) is never listed, as the inbox lists none.
 *
 * Bound to the user by `inviterId`, as the lib binds a party, so no grant on
 * `Invite` is asked; the party route resolves the acting user, and serves
 * only a person signed in as themself.
 */
export function sentEventInviteWhere(userId: string, now: Date, status?: InviteStatus): Prisma.InviteWhereInput {
  const statusWhere: Prisma.InviteWhereInput =
    status === undefined
      ? { status: { in: [...LISTED_BY_DEFAULT_INVITE_STATUSES] } }
      : effectiveInviteStatusWhere(status, now);

  return {
    type: InviteType.Event,
    inviterId: userId,
    event: { is: liveEventWhere() },
    AND: [
      statusWhere,
      {
        OR: [
          { event: { is: { attendees: { some: { userId, ...NOT_REMOVED } } } } },
          { status: { in: [...OUTSTANDING_INVITE_STATUSES] }, ...unexpiredInviteWhere(now) },
        ],
      },
    ],
  };
}
