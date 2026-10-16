import {
  EventParticipationStatus,
  NominationStatus,
  OccurrenceStatus,
  Prisma,
  type EventAttendee,
} from '@bge/database';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GameRemovedFromEventEvent,
  NominationPausedEvent,
  NominationResumedEvent,
} from '../nomination/events/nomination.events';

/**
 * Whether an attendee is out of the event: removed by a host, or not
 * attending (#551). Their votes stay and stop counting
 * (`VoteResolver.isEligibleVoter`), and they supply no game.
 */
export function isOutOfEvent(attendee: Pick<EventAttendee, 'removedAt' | 'status'>): boolean {
  return attendee.removedAt !== null || attendee.status === EventParticipationStatus.NotAttending;
}

/** {@link isOutOfEvent}, as a filter on attendees. */
const OUT_OF_EVENT = {
  OR: [{ removedAt: { not: null } }, { status: EventParticipationStatus.NotAttending }],
} satisfies Prisma.EventAttendeeWhereInput;

/** The statuses that await an outcome, which a nomination pauses from and returns to. */
const PAUSABLE_STATUSES = [NominationStatus.Open, NominationStatus.AwaitingApproval] as const;

/**
 * A nomination that has not reached an outcome, paused ones included. A list
 * entry supplying one stays on the list (#551).
 */
export const ACTIVE_NOMINATION_STATUSES: NominationStatus[] = [...PAUSABLE_STATUSES, NominationStatus.Paused];

/**
 * The lineup games still ahead: a date's, while that date may still happen
 * and has not started, and the event's own, while any of its dates is like
 * that or it has none yet. A date may still happen while it is proposed or
 * confirmed, and has not started while its start is unset or to come.
 *
 * Only these leave with a supplier who is out of the event, and only these
 * hold a game on its supplier's offered games (#551). A date that has started
 * keeps its lineup as it stood, as the record of what was planned for it,
 * until a write to the event's dates puts it ahead again
 * ({@link writeEventDates}).
 */
export function lineupStillAhead(now: Date): Prisma.EventGameWhereInput {
  const dateAhead = {
    status: { in: [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed] },
    OR: [{ startDate: null }, { startDate: { gt: now } }],
  } satisfies Prisma.EventOccurrenceWhereInput;

  return {
    OR: [
      { occurrence: { is: dateAhead } },
      {
        occurrenceId: null,
        event: { is: { OR: [{ occurrences: { some: dateAhead } }, { occurrences: { none: {} } }] } },
      },
    ],
  };
}

const SCHEDULED_GAME_SNAPSHOT_SELECT = {
  id: true,
  eventId: true,
  occurrenceId: true,
  platformGameId: true,
  suppliedById: true,
  nominationId: true,
  addedById: true,
  role: true,
} as const satisfies Prisma.EventGameSelect;

/** A lineup game as it stood when it was taken off, for the domain event that reports it. */
export type RemovedLineupGame = Prisma.EventGameGetPayload<{ select: typeof SCHEDULED_GAME_SNAPSHOT_SELECT }>;

interface NominationStatusChange {
  id: string;
  from: NominationStatus;
  to: NominationStatus;
}

/** What {@link syncSuppliedGames} changed, for the caller to emit once it commits. */
export interface SuppliedGameChanges {
  paused: NominationStatusChange[];
  resumed: NominationStatusChange[];
  removedGames: RemovedLineupGame[];
}

/** A game-list entry as a supply check reads it: whose it is, which game, and whether either was removed. */
export interface LockedSupplier {
  eventId: string;
  platformGameId: string;
  status: EventParticipationStatus;
  attendeeRemovedAt: Date | null;
  entryRemovedAt: Date | null;
}

/**
 * Reads a game-list entry and its attendee for a write that names the entry
 * as a game's supplier, and holds both rows `FOR SHARE` until the caller's
 * transaction ends. `null` when no entry has the id.
 *
 * The lock is what makes the answer last until the write commits. Leaving the
 * event updates the attendee row, and taking the game off the list locks the
 * entry `FOR UPDATE`, and each conflicts with the share lock: whichever comes
 * second waits, then sees the first. Without it, a nomination could open on
 * a game whose supplier left a moment before, and nothing would pause it.
 *
 * Take it before any other lock the write needs, as {@link syncSuppliedGames}
 * comes after the attendee row's: the attendee row first, then the event's
 * ({@link lockEventDates}), then nominations.
 */
export async function lockSupplier(tx: Prisma.TransactionClient, gameListId: string): Promise<LockedSupplier | null> {
  const rows = await tx.$queryRaw<LockedSupplier[]>(Prisma.sql`
    SELECT a.event_id AS "eventId",
           c.platform_game_id AS "platformGameId",
           a.status AS "status",
           a.removed_at AS "attendeeRemovedAt",
           l.removed_at AS "entryRemovedAt"
    FROM attendee_game_lists l
    JOIN event_attendees a ON a.id = l.attendee_id
    JOIN game_collections c ON c.id = l.collection_id
    WHERE l.id = ${gameListId}
    FOR SHARE OF l, a
  `);

  return rows[0] ?? null;
}

/**
 * Locks the event's row `FOR SHARE` until the caller's transaction ends, so
 * the event's dates stay as they are while the caller judges which lineups
 * are still ahead (#551). A write that can leave a lineup game with nobody
 * bringing it takes it before that read: a supplier leaving the event, or an
 * entry coming off their offered games.
 *
 * A write to the event's dates takes the same row `FOR NO KEY UPDATE`
 * ({@link writeEventDates}), which conflicts with this: whichever comes
 * second waits, then sees the first. Without this lock, a supplier could
 * leave while a date that has started is moved to a start still to come.
 * Their leaving would read the date as started and keep their game in its
 * lineup, and the move, reading before they left, would see them in the
 * event, so the lineup would end up ahead, holding a game nobody is
 * bringing.
 *
 * Adding a game to a lineup waits for neither. Its supplier is in the event
 * when it is added ({@link lockSupplier}), and whichever of the two runs when
 * they leave judges it then.
 */
export async function lockEventDates(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${eventId} FOR SHARE`);
}

/**
 * Brings the games an attendee supplies into line with whether they are in
 * the event (#551).
 *
 * - **Out:** each nomination of a game from their list that awaits an
 *   outcome pauses, whoever made it, and remembers the status it paused
 *   from. Its votes stay. The games they supply leave the lineup of every
 *   date still ahead ({@link lineupStillAhead}), as of `now`, and are not
 *   put back: by the time they are back, the host may have filled the slot.
 * - **In:** each paused nomination of a game from their list returns to the
 *   status it paused from.
 *
 * It reads the attendee's state as given, not the change that led to it, so
 * running it twice changes nothing, and a caller need not know the state it
 * replaced. Run it in the transaction that wrote that state, AFTER the write:
 * the write's row lock is what keeps a nomination or direct add from naming
 * this attendee's games until the transaction commits (`lockSupplier`).
 *
 * It locks the event's row first ({@link lockEventDates}), before any
 * nomination: removing a date writes to the nominations that name it while
 * holding that row, so locking a nomination first could deadlock with it.
 */
export async function syncSuppliedGames(
  tx: Prisma.TransactionClient,
  attendee: Pick<EventAttendee, 'id' | 'eventId' | 'removedAt' | 'status'>,
  now: Date,
): Promise<SuppliedGameChanges> {
  await lockEventDates(tx, attendee.eventId);

  const changes: SuppliedGameChanges = { paused: [], resumed: [], removedGames: [] };
  const fromTheirList = {
    suppliedFrom: { is: { attendeeId: attendee.id } },
  } satisfies Prisma.EventGameNominationWhereInput;

  if (!isOutOfEvent(attendee)) {
    for (const status of PAUSABLE_STATUSES) {
      const resumed = await tx.eventGameNomination.updateManyAndReturn({
        where: { ...fromTheirList, status: NominationStatus.Paused, pausedFrom: status },
        data: { status, pausedFrom: null },
        select: { id: true },
      });
      changes.resumed.push(...resumed.map((row) => ({ ...row, from: NominationStatus.Paused, to: status })));
    }

    return changes;
  }

  for (const status of PAUSABLE_STATUSES) {
    const paused = await tx.eventGameNomination.updateManyAndReturn({
      where: { ...fromTheirList, status },
      data: { status: NominationStatus.Paused, pausedFrom: status },
      select: { id: true },
    });
    changes.paused.push(...paused.map((row) => ({ ...row, from: status, to: NominationStatus.Paused })));
  }

  changes.removedGames = await tx.eventGame.findMany({
    where: { suppliedBy: { is: { attendeeId: attendee.id } }, ...lineupStillAhead(now) },
    select: SCHEDULED_GAME_SNAPSHOT_SELECT,
  });

  if (changes.removedGames.length > 0) {
    await tx.eventGame.deleteMany({ where: { id: { in: changes.removedGames.map((game) => game.id) } } });
  }

  return changes;
}

/**
 * Runs `write`, a write to an event's dates, and takes off the lineup each
 * game it put back ahead that nobody is bringing: its supplier is out of the
 * event, or its entry came off their offered games (#551).
 *
 * Neither takes a game off a date that has started ({@link lineupStillAhead}).
 * Moving that date's start to one still to come, adding a date to an event
 * whose dates have all started, or removing its last date, puts the lineup
 * ahead again, and no route takes a game off a lineup. No other write does:
 * a declined or cancelled date never returns to proposed or confirmed.
 *
 * The event's row is locked `FOR NO KEY UPDATE` before the write, so this
 * and each write that can leave a lineup game with nobody bringing it take
 * turns ({@link lockEventDates}). One that commits first is seen by the
 * read after the write. One that comes second waits for this to commit,
 * then finds the lineup ahead itself. Two date writes to one event take
 * turns the same way.
 */
export async function writeEventDates<T>(
  tx: Prisma.TransactionClient,
  eventId: string,
  now: Date,
  write: () => Promise<T>,
): Promise<{ written: T; removedGames: RemovedLineupGame[] }> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${eventId} FOR NO KEY UPDATE`);

  const written = await write();

  const removedGames = await tx.eventGame.findMany({
    where: {
      suppliedBy: {
        is: {
          attendee: { is: { eventId } },
          OR: [{ removedAt: { not: null } }, { attendee: { is: OUT_OF_EVENT } }],
        },
      },
      ...lineupStillAhead(now),
    },
    select: SCHEDULED_GAME_SNAPSHOT_SELECT,
  });

  if (removedGames.length > 0) {
    await tx.eventGame.deleteMany({ where: { id: { in: removedGames.map((game) => game.id) } } });
  }

  return { written, removedGames };
}

/** Emits a domain event for each lineup game taken off. Call it after the transaction commits. */
export function emitRemovedGames(
  emitter: EventEmitter2,
  eventId: string,
  games: RemovedLineupGame[],
  initiatedAt: Date,
): void {
  for (const game of games) {
    emitter.emit(GameRemovedFromEventEvent.eventName, new GameRemovedFromEventEvent(game, eventId, initiatedAt));
  }
}

/** Emits one domain event per row {@link syncSuppliedGames} changed. Call it after the transaction commits. */
export function emitSuppliedGameChanges(
  emitter: EventEmitter2,
  eventId: string,
  changes: SuppliedGameChanges,
  initiatedAt: Date,
): void {
  for (const { id, from, to } of changes.paused) {
    emitter.emit(
      NominationPausedEvent.eventName,
      new NominationPausedEvent({ id, eventId, status: from }, { id, eventId, status: to }, initiatedAt),
    );
  }

  for (const { id, from, to } of changes.resumed) {
    emitter.emit(
      NominationResumedEvent.eventName,
      new NominationResumedEvent({ id, eventId, status: from }, { id, eventId, status: to }, initiatedAt),
    );
  }

  emitRemovedGames(emitter, eventId, changes.removedGames, initiatedAt);
}
