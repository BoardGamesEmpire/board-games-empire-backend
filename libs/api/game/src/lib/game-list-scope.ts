import { type Prisma, Reach } from '@bge/database';

/**
 * The set a collection read of games is about: the live Public games, and the
 * caller's own whatever their reach. `GET /games` and both local title
 * searches, REST and WebSocket, declare it through `ScopeComposer.compose`,
 * so the caller's ceiling clips it (#513).
 *
 * It is one rule for every role. Before, those reads took the ceiling
 * as their answer, so staff listed and found every private game on the server
 * through `read:public_content`, and the Owner through `manage:all`. A private
 * game staff can read stays readable by id. It is narrowed out of the lists,
 * not withdrawn.
 *
 * Written once, for the list and the search alike, so a change to the
 * reaches it reads, such as friends' games (#809), is one edit.
 */
export function gameListScope(subjectId: string): Prisma.GameWhereInput {
  return {
    deletedAt: null,
    OR: [{ reach: Reach.Public }, { createdById: subjectId }],
  };
}
