import type { EventGame, Prisma } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';

/**
 * Where an actor may read an event's lineup games (#799): the event's own
 * games, and the games of each date the actor can read.
 *
 * The lineup's read ceiling names a date's games through the date's event, so
 * it can't keep them from an actor who reads the lineup but not the date, such
 * as a key holding read on the lineup alone. The dates are read first, under
 * their own ceiling, and only their games are named. Every read of lineup
 * games ANDs this beside the lineup's ceiling.
 *
 * `dateIds`, when given, limits the dates read to those, and an empty list
 * reads none. `db` may be a write's transaction, so the read runs before its
 * commit.
 */
export async function readableLineupWhere(
  db: Prisma.TransactionClient,
  scopeComposer: ScopeComposer,
  eventId: string,
  dateIds?: string[],
): Promise<Prisma.EventGameWhereInput> {
  const dates =
    dateIds?.length === 0
      ? []
      : await db.eventOccurrence.findMany({
          where: scopeComposer.compose(ResourceType.EventOccurrence, Action.read, {
            eventId,
            ...(dateIds ? { id: { in: dateIds } } : {}),
          }),
          select: { id: true },
        });

  return { OR: [{ eventId }, { occurrenceId: { in: dates.map(({ id }) => id) } }] };
}

/**
 * The lineup game each of the event's nominations became, keyed by
 * nomination, as far as the actor may read it (#799):
 *
 * - It is a top-level read under the lineup's read ceiling, since in the
 *   nominations' include it would reach an actor who can't read the lineup.
 * - A date's game is named only through a date the actor can read, as the
 *   lineup read names it ({@link readableLineupWhere}). A lineup game is on
 *   its nomination's date, so `dateIds` are the dates the nominations name.
 * - A lineup game names its nomination uniquely, so each nomination has one
 *   at most.
 */
export async function readableLineupGamesByNomination(
  db: Prisma.TransactionClient,
  scopeComposer: ScopeComposer,
  eventId: string,
  nominations: { dateIds: string[]; nominationIds: string[] },
): Promise<ReadonlyMap<string, Pick<EventGame, 'id' | 'occurrenceId'>>> {
  if (nominations.nominationIds.length === 0) {
    return new Map();
  }

  const games = await db.eventGame.findMany({
    where: scopeComposer.compose(ResourceType.EventGame, Action.read, {
      nominationId: { in: nominations.nominationIds },
      ...(await readableLineupWhere(db, scopeComposer, eventId, nominations.dateIds)),
    }),
    select: { id: true, occurrenceId: true, nominationId: true },
  });

  return new Map(
    games.flatMap(({ id, occurrenceId, nominationId }) =>
      nominationId === null ? [] : [[nominationId, { id, occurrenceId }] as const],
    ),
  );
}
