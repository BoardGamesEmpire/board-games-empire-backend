import type { Prisma } from '../client';
import { FriendshipStatus, Reach } from '../client';

/**
 * The rungs of the reach ladder that admit a friend: `Friends` and every rung
 * above it. The ladder reads upwards, so a wider reach keeps the readers of a
 * narrower one (#495). `FriendsOfFriends` admits direct friends only until
 * #496 defines friends of friends. Frozen: the catalog copies it once at load
 * and list scopes read it on every call, so a change made at run time would
 * set the two apart.
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
