import { InviteStatus, InviteType, Prisma, type DatabaseService } from '@bge/database';
import { receivedInviteWhere, unexpiredInviteWhere } from '@bge/invites';

/**
 * The address the household routes vouch is the user's: their own, once
 * verified. Anyone can register an address they cannot read, and vouching
 * for that one would hand them every invite sent to it. Whether more than a
 * verified address should count is #724's question, and this is the one
 * place it is answered; the notification listener (#167) asks the same
 * question through this helper.
 */
export async function vouchedEmailOf(
  client: DatabaseService | Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } });

  return user?.emailVerified ? user.email : null;
}

/**
 * The household invites open to this user in their inbox (#163, #166, #278):
 * those naming them by id, and those to their vouched address. Only the ones
 * still open to them: `Pending`, unexpired, into a household that is live and
 * that they are not already in. One awaiting approval is not: until a
 * household owner or household admin approves it, it is a member's proposal
 * rather than the household's offer, and showing it, then revoking it, would
 * tell the invitee about the household's own deliberations (#166). A withheld
 * invite never is (#278); the invites lib's filter, `receivedInviteWhere`,
 * leaves it out.
 *
 * An invite into a household they already belong to stays outstanding (an
 * accept of it is refused), so it is hidden rather than offered.
 *
 * The inbox lists by this predicate, and the notification listener (#167)
 * counts by it before telling a user of an invite, so no one is notified of
 * an invite their inbox would not show.
 */
export function receivedHouseholdInviteWhere(
  userId: string,
  vouchedEmail: string | null,
  now: Date,
): Prisma.InviteWhereInput {
  return {
    type: InviteType.Household,
    AND: [
      receivedInviteWhere(userId, vouchedEmail),
      { status: InviteStatus.Pending },
      unexpiredInviteWhere(now),
      { household: { is: { deletedAt: null, members: { none: { userId } } } } },
    ],
  };
}
