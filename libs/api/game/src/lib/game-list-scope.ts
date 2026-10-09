import { type Prisma, Visibility } from '@bge/database';

/**
 * The set a collection read of games is about: the live Public games, and the
 * caller's own whatever their visibility. `GET /games` and both local title
 * searches, REST and WebSocket, declare it through `ScopeComposer.compose`,
 * so the caller's ceiling clips it (#513).
 *
 * It is one rule for every role. Before, those reads took the ceiling
 * as their answer, so staff listed and found every private game on the server
 * through `read:public_content`, and the Owner through `manage:all`. A private
 * game staff can read stays readable by id. It is narrowed out of the lists,
 * not withdrawn.
 *
 * Written once, for the list and the search alike, because the visibility
 * tiers it reads are being replaced (#495), and that should be one edit.
 */
export function gameListScope(subjectId: string): Prisma.GameWhereInput {
  return {
    deletedAt: null,
    OR: [{ visibility: Visibility.Public }, { createdById: subjectId }],
  };
}
