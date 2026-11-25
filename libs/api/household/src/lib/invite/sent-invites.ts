import type { InviteStatus, Prisma } from '@bge/database';
import { InviteType } from '@bge/database';
import {
  effectiveInviteStatusWhere,
  LISTED_BY_DEFAULT_INVITE_STATUSES,
  OUTSTANDING_INVITE_STATUSES,
  unexpiredInviteWhere,
} from '@bge/invites';

/**
 * The household invites this user has sent (#751): how a household member
 * who invited finds their invites, since only an owner or admin reads the
 * household's list.
 *
 * By default, the invites still open and those that expired; `status` picks
 * any one status as it stands now, as the household's list does. The list
 * reports each row's status as it stands now, so an outstanding row past its
 * date reads `Expired`.
 *
 * Into a household the inviter is not a member of, only the invites they
 * can still withdraw are listed, outstanding and unexpired, whatever the
 * filter asks: a server owner may invite into any household without a seat
 * in it. A former member has nothing left to withdraw there, since leaving
 * or being removed revoked it (#747), and a settled invite there would go on
 * telling them who joined. An invite into a deleted household is never
 * listed, as the inbox lists none; the delete revoked it.
 *
 * Bound to the user by `inviterId`, as the lib binds a party, so no grant on
 * `Invite` is asked; the party route resolves the acting user, and serves
 * only a person signed in as themself (#742). A withheld invite is listed
 * like any other, since its inviter must not be able to tell (#278), and the
 * row carries no sign of it.
 */
export function sentHouseholdInviteWhere(userId: string, now: Date, status?: InviteStatus): Prisma.InviteWhereInput {
  const statusWhere: Prisma.InviteWhereInput =
    status === undefined
      ? { status: { in: [...LISTED_BY_DEFAULT_INVITE_STATUSES] } }
      : effectiveInviteStatusWhere(status, now);

  return {
    type: InviteType.Household,
    inviterId: userId,
    household: { is: { deletedAt: null } },
    AND: [
      statusWhere,
      {
        OR: [
          { household: { is: { members: { some: { userId } } } } },
          { status: { in: [...OUTSTANDING_INVITE_STATUSES] }, ...unexpiredInviteWhere(now) },
        ],
      },
    ],
  };
}
