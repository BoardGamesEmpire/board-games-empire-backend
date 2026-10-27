import {
  acceptedFriendOf,
  friendOfFriendOf,
  gameSharedWith,
  type Prisma,
  Reach,
  REACHES_ADMITTING_FRIENDS,
} from '@bge/database';

/**
 * The set a collection read of games is about: the live Public games, the
 * acting user's own whatever their reach, a friend's that reach their friends,
 * a friend of a friend's that reach friends of friends, and the games shared
 * with the acting user, by name or through a household they belong to, once
 * each share is in effect (#810). A block between the acting user and the
 * creator keeps the friends' and friends of friends' games out (#496), and
 * vetoes a share naming the acting user, but not a share to a household, which
 * names no one user (#810). `GET /games` and both local title searches, REST
 * and WebSocket, declare it through `ScopeComposer.compose`, so the acting
 * user's ceiling clips it (#513).
 *
 * It is one rule for every role. Before, those reads took the ceiling
 * as their answer, so staff listed and found every private game on the server
 * through `read:public_content`, and the Owner through `manage:all`. A private
 * game staff can read stays readable by id. It is narrowed out of the lists,
 * not withdrawn. The friends and friends-of-friends branches name the
 * friendships themselves, rather than leaving them to `read:game:friends` and
 * `read:game:friends-of-friends`, so staff are listed their own friends' and
 * friends of friends' games and no one else's. The shared branch names the
 * shares themselves for the same reason, rather than leaving them to
 * `read:game:shared`, so staff are listed the games shared with them and no
 * one else's.
 *
 * The friends-of-friends branch is shaped as its rule is, the reach test first
 * in an `AND`: the second friendship step runs once per row it reaches, so it
 * should reach only the games at `FriendsOfFriends`.
 *
 * The shared branch is `gameSharedWith`, the condition `read:game:shared`
 * reads by, so a game a share lets a user read by id is one they can find. It
 * leaves the game's own `deletedAt` to the test at the top of this scope, and a
 * share still waiting for approval, or into a soft-deleted household, lists
 * nothing. Its user arm carries the block veto and its household arm does not.
 *
 * Written once, for the list and the search alike, so a change to the
 * reaches it reads is one edit.
 */
export function gameListScope(subjectId: string): Prisma.GameWhereInput {
  return {
    deletedAt: null,
    OR: [
      { reach: Reach.Public },
      { createdById: subjectId },
      { reach: { in: [...REACHES_ADMITTING_FRIENDS] }, createdBy: { is: acceptedFriendOf(subjectId) } },
      { AND: [{ reach: Reach.FriendsOfFriends }, { createdBy: { is: friendOfFriendOf(subjectId) } }] },
      gameSharedWith(subjectId),
    ],
  };
}
