import { FriendshipStatus, Prisma, Visibility } from '@bge/database';
import { t } from '@bge/i18n';
import { normalizeInviteeEmail } from '@bge/invites';
import { ForbiddenException } from '@nestjs/common';

/** The invitee as the create stores them: an account by id, or an address alone. */
export type StoredInvitee =
  | { readonly inviteeId: string; readonly inviteeEmail: null }
  | { readonly inviteeId: null; readonly inviteeEmail: string };

/**
 * The account the gate asks about: by id, or as whichever account holds an
 * address. Never a partial filter: `{ email: undefined }` would match every
 * account.
 */
type Invitee = { readonly id: string } | { readonly email: string };

/**
 * Whether the invitee may get an invite from the inviter (#278), asked in the
 * create's transaction once the invitee is known and before anything is
 * written. Three checks, in this order:
 *
 * 1. The server's policy. `Friends` lets in the inviter's friends by id and
 *    refuses every invite by address, before anything about the address is
 *    read: if a friend's address passed where any other failed, the inviter
 *    could test which addresses belong to their friends. It refuses in its
 *    own words.
 * 2. A block between the two, whichever of them placed it, at every policy.
 * 3. The invitee's own preference, which can narrow the server's policy and
 *    never widen it, since both must pass.
 *
 * By id, the inviter already knows who the invitee is, so the second and
 * third refuse with 403, in one message that does not say which applied.
 *
 * By address, they refuse nothing. The invite is stored withheld, and answers
 * as every other invite by address does, so the answer never depends on who
 * holds the address. They read any account holding it, verified or not:
 * proof that the account owns the address matters to a grant, and these only
 * deny.
 *
 * The policy is checked first so that it alone decides an address under
 * `Friends`. A block checked first would let a blocker's address be withheld,
 * looking sent, while every other address was refused.
 *
 * @returns whether to store the invite withheld.
 */
export async function gateInvitee(
  tx: Prisma.TransactionClient,
  inviterId: string,
  invitee: StoredInvitee,
): Promise<{ readonly withheld: boolean }> {
  const policy = await serverInviteePolicy(tx);

  if (invitee.inviteeId === null) {
    if (policy !== Visibility.Public) {
      throw new ForbiddenException(t('errors.household.invitee_friends_only'));
    }

    return { withheld: await addressHolderRefuses(tx, inviterId, invitee.inviteeEmail) };
  }

  const holder = { id: invitee.inviteeId };
  const status = await friendshipStatus(tx, inviterId, holder);

  if (!reaches(policy, status)) {
    throw new ForbiddenException(t('errors.household.invitee_friends_only'));
  }

  if (refuses(status, await invitePreference(tx, holder))) {
    throw new ForbiddenException(t('errors.household.invitee_refused'));
  }

  return { withheld: false };
}

/**
 * The server's policy, read in the caller's transaction. No settings row
 * reads as the column's default.
 */
async function serverInviteePolicy(tx: Prisma.TransactionClient): Promise<Visibility> {
  const settings = await tx.systemSetting.findUnique({
    where: { singleton: true },
    select: { householdInviteePolicy: true },
  });

  return settings?.householdInviteePolicy ?? Visibility.Public;
}

/**
 * Whether the account holding the address, if one does, keeps the invite from
 * the inviter.
 *
 * The holder is never looked up on its own. Both reads filter through the
 * address, and both always run, so the create makes the same two reads whether
 * no account holds the address, its holder admits the inviter, or its holder
 * refuses them. How long the answer takes then says no more than the answer.
 */
async function addressHolderRefuses(
  tx: Prisma.TransactionClient,
  inviterId: string,
  address: string,
): Promise<boolean> {
  // As the lib stores an invite's address, which is how the inbox (#163)
  // matches one to an account. better-auth lower-cases an account's address on
  // every path that writes one.
  const email = normalizeInviteeEmail(address);

  // A blank address names nobody, and the insert refuses it.
  if (email === null) {
    return false;
  }

  const holder = { email };

  return refuses(await friendshipStatus(tx, inviterId, holder), await invitePreference(tx, holder));
}

/** Whether a block between the pair, or the invitee's own preference, keeps the invite from them. */
function refuses(status: FriendshipStatus | null, preference: Visibility): boolean {
  return status === FriendshipStatus.Blocked || !reaches(preference, status);
}

/**
 * Who the invitee lets invite them. No preferences row, or no account, reads
 * as the column's default, as a friend request reads `allowFriendRequests`.
 */
async function invitePreference(tx: Prisma.TransactionClient, invitee: Invitee): Promise<Visibility> {
  const preferences = await tx.userPreferences.findFirst({
    where: { user: invitee },
    select: { allowHouseholdInvitesFrom: true },
  });

  return preferences?.allowHouseholdInvitesFrom ?? Visibility.Public;
}

/**
 * The pair's friendship status, whichever of the two asked, or null when they
 * have none. The blocker of a blocked pair may be either one.
 *
 * Read by both directions rather than by `pairKey`, whose encoding belongs to
 * the friendship lib. The answer is the same: a pair's `pairKey` is unique, so
 * it has one row at most.
 */
async function friendshipStatus(
  tx: Prisma.TransactionClient,
  inviterId: string,
  invitee: Invitee,
): Promise<FriendshipStatus | null> {
  const friendship = await tx.friendship.findFirst({
    where: {
      OR: [
        { requesterId: inviterId, addressee: invitee },
        { addresseeId: inviterId, requester: invitee },
      ],
    },
    select: { status: true },
  });

  return friendship?.status ?? null;
}

/**
 * Whether a level of the reach ladder lets in someone with this friendship
 * status to the person it protects.
 *
 * Only `Public` and `Friends`, and `Private` for the preference, can be set.
 * The other two fail closed if a write that skips the routes stores them:
 * `FriendsOfFriends` reads as `Friends` until #496 defines the second degree,
 * and `Household`, which names no group an inviter could be in, as `Private`.
 */
function reaches(level: Visibility, status: FriendshipStatus | null): boolean {
  switch (level) {
    case Visibility.Public:
      return true;
    case Visibility.Friends:
    case Visibility.FriendsOfFriends:
      return status === FriendshipStatus.Accepted;
    case Visibility.Household:
    case Visibility.Private:
      return false;
  }
}
