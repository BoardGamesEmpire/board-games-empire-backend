import type { Prisma } from '../client';
import { FriendshipStatus, Reach } from '../client';

/**
 * The rungs of the reach ladder that admit a friend: `Friends` and every rung
 * above it. The ladder reads upwards, so a wider reach keeps the readers of a
 * narrower one (#495). Direct friends read up the ladder through the friends
 * rules, and friends of friends through their own rules (#496). Frozen: the
 * catalog copies it once at load and list scopes read it on every call, so a
 * change made at run time would set the two apart.
 */
export const REACHES_ADMITTING_FRIENDS = Object.freeze([Reach.Friends, Reach.FriendsOfFriends, Reach.Public] as const);

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

/** A block between the user being matched and `userId`, whichever placed it. */
function blockWith(userId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { friendshipsRequested: { some: { addresseeId: userId, status: FriendshipStatus.Blocked } } },
      { friendshipsReceived: { some: { requesterId: userId, status: FriendshipStatus.Blocked } } },
    ],
  };
}
