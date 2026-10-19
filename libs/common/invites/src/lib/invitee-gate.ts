import { FriendshipStatus, InviteType, Prisma, Reach } from '@bge/database';
import { t } from '@bge/i18n';
import { ForbiddenException } from '@nestjs/common';
import { normalizeInviteeEmail } from './invite.service';

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

/** The invites the gate rules on: each reads settings of its own. */
export type GatedInviteType = typeof InviteType.Household | typeof InviteType.Event;

/**
 * Which of the server's settings and the invitee's preferences decide each
 * type, and the words it refuses in. Joining a household shares its
 * collection, while an event is one evening, so the two are set apart (#546).
 */
const GATE_SETTINGS = {
  [InviteType.Household]: {
    policy: 'householdInviteePolicy',
    preference: 'allowHouseholdInvitesFrom',
    friendsOnly: 'errors.household.invitee_friends_only',
    refused: 'errors.household.invitee_refused',
  },
  [InviteType.Event]: {
    policy: 'eventInviteePolicy',
    preference: 'allowEventInvitesFrom',
    friendsOnly: 'errors.event.invitee_friends_only',
    refused: 'errors.event.invitee_refused',
  },
} as const satisfies Record<
  GatedInviteType,
  {
    policy: keyof Prisma.SystemSettingSelect;
    preference: keyof Prisma.UserPreferencesSelect;
    friendsOnly: string;
    refused: string;
  }
>;

type GateSettings = (typeof GATE_SETTINGS)[GatedInviteType];

/**
 * Whether the invitee may get an invite of this type from the inviter (#278),
 * asked in the create's transaction once the invitee is known and before
 * anything is written. Each type reads its own settings ({@link GATE_SETTINGS}).
 * Three checks, in this order:
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
  type: GatedInviteType,
  inviterId: string,
  invitee: StoredInvitee,
): Promise<{ readonly withheld: boolean }> {
  const settings = GATE_SETTINGS[type];
  const policy = await serverInviteePolicy(tx, settings);

  if (invitee.inviteeId === null) {
    if (policy !== Reach.Public) {
      throw new ForbiddenException(t(settings.friendsOnly));
    }

    return { withheld: await addressHolderRefuses(tx, settings, inviterId, invitee.inviteeEmail) };
  }

  const holder = { id: invitee.inviteeId };
  const status = await friendshipStatus(tx, inviterId, holder);

  if (!reaches(policy, status)) {
    throw new ForbiddenException(t(settings.friendsOnly));
  }

  if (refuses(status, await invitePreference(tx, settings, holder))) {
    throw new ForbiddenException(t(settings.refused));
  }

  return { withheld: false };
}

/**
 * The server's policy for the type, read in the caller's transaction. No
 * settings row reads as the column's default.
 */
async function serverInviteePolicy(tx: Prisma.TransactionClient, settings: GateSettings): Promise<Reach> {
  const row = await tx.systemSetting.findUnique({
    where: { singleton: true },
    select: { householdInviteePolicy: true, eventInviteePolicy: true },
  });

  return row?.[settings.policy] ?? Reach.Public;
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
  settings: GateSettings,
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

  return refuses(await friendshipStatus(tx, inviterId, holder), await invitePreference(tx, settings, holder));
}

/** Whether a block between the pair, or the invitee's own preference, keeps the invite from them. */
function refuses(status: FriendshipStatus | null, preference: Reach): boolean {
  return status === FriendshipStatus.Blocked || !reaches(preference, status);
}

/**
 * Who the invitee lets invite them, to this type. No preferences row, or no
 * account, reads as the column's default, as a friend request reads
 * `allowFriendRequests`.
 */
async function invitePreference(
  tx: Prisma.TransactionClient,
  settings: GateSettings,
  invitee: Invitee,
): Promise<Reach> {
  const preferences = await tx.userPreferences.findFirst({
    where: { user: invitee },
    select: { allowHouseholdInvitesFrom: true, allowEventInvitesFrom: true },
  });

  return preferences?.[settings.preference] ?? Reach.Public;
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
 * `FriendsOfFriends` fails closed if a write that skips the routes stores it:
 * it reads as `Friends` until #496 defines friends of friends.
 */
function reaches(level: Reach, status: FriendshipStatus | null): boolean {
  switch (level) {
    case Reach.Public:
      return true;
    case Reach.Friends:
    case Reach.FriendsOfFriends:
      return status === FriendshipStatus.Accepted;
    case Reach.Private:
      return false;
  }
}
