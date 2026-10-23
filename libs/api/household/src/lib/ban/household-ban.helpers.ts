import { DatabaseService, Prisma } from '@bge/database';
import { normalizeInviteeEmail } from '@bge/invites';

/**
 * Whether the household has banned this user (#782). An admission asks it
 * under the household lock, so a ban committing first is seen; the invite
 * create asks it of an invitee named by id.
 */
export async function isBannedWithin(
  client: Prisma.TransactionClient | DatabaseService,
  householdId: string,
  userId: string,
): Promise<boolean> {
  const ban = await client.householdBan.findUnique({
    where: { householdId_userId: { householdId, userId } },
    select: { id: true },
  });

  return ban !== null;
}

/**
 * Whether the user holding this address, if one does, is banned from the
 * household (#782), for an invite by address. Reads whichever user holds it,
 * verified or not, as the invitee gate does: these only deny.
 *
 * The address is compared as the invites lib stores it, trimmed and
 * lower-cased, and exactly: better-auth lower-cases a user's address on
 * every path that writes one. `mode: 'insensitive'` would be ILIKE, where `_`
 * and `%` in an address are wildcards.
 */
export async function addressHolderBannedWithin(
  client: Prisma.TransactionClient,
  householdId: string,
  address: string,
): Promise<boolean> {
  const email = normalizeInviteeEmail(address);

  // A blank address names nobody, and the insert refuses it.
  if (email === null) {
    return false;
  }

  return (await client.householdBan.count({ where: { householdId, user: { is: { email } } } })) > 0;
}
