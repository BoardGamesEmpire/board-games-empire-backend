import { acceptedFriendOf, type Prisma, Reach, REACHES_ADMITTING_FRIENDS } from '@bge/database';

/**
 * The set a collection read of games is about: the live Public games, the
 * acting user's own whatever their reach, and a friend's that reach their
 * friends. `GET /games` and both local title searches, REST and WebSocket,
 * declare it through `ScopeComposer.compose`, so the acting user's ceiling
 * clips it (#513).
 *
 * It is one rule for every role. Before, those reads took the ceiling
 * as their answer, so staff listed and found every private game on the server
 * through `read:public_content`, and the Owner through `manage:all`. A private
 * game staff can read stays readable by id. It is narrowed out of the lists,
 * not withdrawn. The friends branch names the friendship itself, rather than
 * leaving it to `read:game:friends`, so staff are listed their own friends'
 * games and no one else's.
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
    ],
  };
}
