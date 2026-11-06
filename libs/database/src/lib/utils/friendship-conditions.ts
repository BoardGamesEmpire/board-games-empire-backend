import type { Prisma } from '../client';
import { FriendshipStatus, Reach } from '../client';

/**
 * The rungs of the reach ladder that admit a friend: `Friends` and every rung
 * above it. The ladder reads upwards, so a wider reach keeps the readers of a
 * narrower one (#495). Direct friends read up the ladder through the friends
 * permissions, friends of friends through their own (#496), and the extended
 * network through permissions that read the extended network table (#497). Frozen: the
 * catalog copies it once at load and list scopes read it on every call, so a
 * change made at run time would set the two apart.
 */
export const REACHES_ADMITTING_FRIENDS = Object.freeze([
  Reach.Friends,
  Reach.FriendsOfFriends,
  Reach.ExtendedNetwork,
  Reach.Public,
] as const);

/** How many accepted friendship steps the extended network reaches (#497). */
export const EXTENDED_NETWORK_STEPS = 3;

/**
 * The users who are accepted friends of `userId`, in either direction: a
 * friendship is a single directional row, so both are checked. The catalog
 * renders it against `{{ user.id }}`, and a list scope against the acting
 * user's id, so a rule and a list agree on who a friend is.
 *
 * A new clause on every call. The catalog holds its rendering by reference in
 * every entry that uses it, and a shared object would let one consumer's edit
 * reach another's clause.
 */
export function acceptedFriendOf(userId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { friendshipsRequested: { some: { addresseeId: userId, status: FriendshipStatus.Accepted } } },
      { friendshipsReceived: { some: { requesterId: userId, status: FriendshipStatus.Accepted } } },
    ],
  };
}

/**
 * The users who are friends of a friend of `userId`: an accepted friendship
 * away from one of `userId`'s accepted friends, each step checked in both
 * directions (#496). The catalog renders it against `{{ user.id }}`, a list
 * scope against the acting user's id, and the invite gate against the
 * inviter's, so all three agree on who a friend of a friend is.
 *
 * - A block between the matched user and `userId` vetoes the match. At one
 *   step a block needs no check, since the pair's only row is `Blocked` rather
 *   than `Accepted`. At two steps the blocked user would still reach through a
 *   friend they share.
 * - Either user may have placed the block, so both directions are checked.
 * - A user with any friend matches as a friend of a friend of themselves. That
 *   is harmless: an owner already reads their own items through their own
 *   rules.
 *
 * A new clause on every call, as `acceptedFriendOf` builds one.
 */
export function friendOfFriendOf(userId: string): Prisma.UserWhereInput {
  return {
    OR: [
      {
        friendshipsRequested: {
          some: { status: FriendshipStatus.Accepted, addressee: { is: acceptedFriendOf(userId) } },
        },
      },
      {
        friendshipsReceived: {
          some: { status: FriendshipStatus.Accepted, requester: { is: acceptedFriendOf(userId) } },
        },
      },
    ],
    NOT: blockWith(userId),
  };
}

/**
 * The users the extended network table puts within three friendship steps of `userId`,
 * with no block between them (#497). The catalog renders it against
 * `{{ user.id }}`, and `gameListScope` and `browseEventScope` against the
 * acting user's id, so a permission and a list agree on who is in someone's
 * extended network. The table is found by its primary key from the matched
 * user's side.
 *
 * - A worker job rewrites the table's rows a few seconds after each friendship
 *   change, so an unfriend reaches this clause then. A block reaches it at
 *   once: the table stores no blocks, and the veto reads the friendships, as
 *   `friendOfFriendOf`'s does.
 * - The table holds friends and friends of friends too, at one and two steps.
 *   A direct friend is admitted at once through the friends permissions,
 *   which admit the extended network's rung. A friend of a friend reaches an
 *   extended network item through this clause alone, so after the job, like
 *   the third step.
 * - The clause bounds `steps` itself rather than relying on the table's limit,
 *   so the rung stays at three steps if a later, wider rung makes the table
 *   hold more (#497).
 *
 * A new clause on every call, as `acceptedFriendOf` builds one.
 */
export function withinExtendedNetworkOf(userId: string): Prisma.UserWhereInput {
  return {
    extendedNetwork: { some: { otherUserId: userId, steps: { lte: EXTENDED_NETWORK_STEPS } } },
    NOT: blockWith(userId),
  };
}

/**
 * A block between the user being matched and `userId`, whichever placed it.
 * The share rule uses it too, to veto an owner's user share (`gameSharedWith`,
 * #810).
 */
export function blockWith(userId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { friendshipsRequested: { some: { addresseeId: userId, status: FriendshipStatus.Blocked } } },
      { friendshipsReceived: { some: { requesterId: userId, status: FriendshipStatus.Blocked } } },
    ],
  };
}
