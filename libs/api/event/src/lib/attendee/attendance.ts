import type { EventAttendee } from '@bge/database';
import {
  EventParticipationStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  NominationStatus,
  Prisma,
} from '@bge/database';
import { t } from '@bge/i18n';
import { LineupRemovalReason } from '@bge/notifications-service';
import { ConflictException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { ATTENDEE_USER_AND_ROLE_INCLUDE } from '../constants/attendee-user-and-role.constant';
import {
  GameRemovedFromEventEvent,
  NominationPausedEvent,
  NominationResumedEvent,
} from '../nomination/events/nomination.events';
import { LIVE_DATE_STATUSES } from '../occurrence/live-dates.util';
import { lockLiveEventDates } from '../utils/lock-live-event.util';
import type { AssignableAttendeeRole } from './dto/add-attendee.dto';
import { AttendeeAddedEvent } from './events/attendee.events';

/** An attendee row with their user and role. */
export type AttendeeRow = Prisma.EventAttendeeGetPayload<{ include: typeof ATTENDEE_USER_AND_ROLE_INCLUDE }>;

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

/** The attendees {@link isOutOfEvent} says are in the event, as a filter on attendees (#1221). */
export const IN_EVENT = {
  removedAt: null,
  status: { not: EventParticipationStatus.NotAttending },
} satisfies Prisma.EventAttendeeWhereInput;

/** The statuses that await an outcome, which a nomination pauses from and returns to. */
export const PAUSABLE_STATUSES = [NominationStatus.Open, NominationStatus.AwaitingApproval] as const;

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
    status: { in: [...LIVE_DATE_STATUSES] },
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

export const LINEUP_GAME_SNAPSHOT_SELECT = {
  id: true,
  eventId: true,
  occurrenceId: true,
  platformGameId: true,
  suppliedById: true,
  nominationId: true,
  addedById: true,
  role: true,
} as const satisfies Prisma.EventGameSelect;

/** A lineup game's own fields, as the domain events that report it joining or leaving the lineup carry them. */
export type LineupGameSnapshot = Prisma.EventGameGetPayload<{ select: typeof LINEUP_GAME_SNAPSHOT_SELECT }>;

interface NominationStatusChange {
  from: NominationStatus;
  id: string;
  to: NominationStatus;
}

/**
 * What {@link syncSuppliedGames} changed, or `syncCollectionEntrySupply` in
 * one event, for the caller to emit once it commits.
 */
export interface SuppliedGameChanges {
  paused: NominationStatusChange[];
  removedGames: LineupGameSnapshot[];
  resumed: NominationStatusChange[];
}

/**
 * An offer as a supply check reads it: whose it is, which game, and whether
 * the offer, its collection entry or its attendee was removed.
 */
export interface LockedSupplier {
  attendeeRemovedAt: Date | null;
  collectionRemovedAt: Date | null;
  entryRemovedAt: Date | null;
  eventId: string;
  platformGameId: string;
  status: EventParticipationStatus;
}

/**
 * Reads an offer, its attendee and its collection entry for a write that
 * names the offer as a game's supplier, and holds the three rows `FOR SHARE`
 * until the caller's transaction ends. `null` when no offer has the id.
 *
 * The lock is what makes the answer last until the write commits. Leaving the
 * event updates the attendee row, taking the offer back locks it
 * `FOR UPDATE`, and removing the game from its owner's collection
 * updates the collection entry's row (#1221), and each conflicts with the
 * share lock: whichever comes second waits, then sees the first. Without it,
 * a nomination could open on a game whose supplier left, or whose owner
 * removed it, a moment before, and nothing would pause it.
 *
 * Take it before any other lock the write needs. The lock order, and why it
 * can't deadlock with the other writes, is stated once on `shareLiveEvent`.
 */
export async function lockSupplier(tx: Prisma.TransactionClient, gameListId: string): Promise<LockedSupplier | null> {
  const rows = await tx.$queryRaw<LockedSupplier[]>(Prisma.sql`
    SELECT a.event_id AS "eventId",
           c.platform_game_id AS "platformGameId",
           a.status AS "status",
           a.removed_at AS "attendeeRemovedAt",
           c.deleted_at AS "collectionRemovedAt",
           l.removed_at AS "entryRemovedAt"
    FROM attendee_game_lists l
    JOIN event_attendees a ON a.id = l.attendee_id
    JOIN game_collections c ON c.id = l.collection_id
    WHERE l.id = ${gameListId}
    FOR SHARE OF l, a, c
  `);

  return rows[0] ?? null;
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
 *   status it paused from, unless the game was removed from its owner's
 *   collection: nobody supplies it, so it stays paused until the game is
 *   added back (#1221). Leaving pauses a nomination whatever its collection
 *   entry's state.
 *
 * It reads the attendee's state as given, not the change that led to it, so
 * running it twice changes nothing, and a caller need not know the state it
 * replaced. Run it in the transaction that wrote that state, AFTER the write:
 * the write's row lock is what keeps a nomination or direct add from naming
 * this attendee's games until the transaction commits (`lockSupplier`).
 *
 * It locks the event's row `FOR SHARE` first, before any nomination:
 * removing a date writes to the nominations that name it while holding that
 * row, so locking a nomination first could deadlock with it. The same lock
 * holds the event's dates while this judges which lineups are still ahead.
 * Each caller has already taken it, checking the event is live
 * (`shareLiveEvent`, #1065), so here it costs one round trip and changes
 * nothing; it is taken again so that a caller that skips it still keeps both
 * guarantees.
 *
 * Then, before any nomination, it holds the collection entries of the
 * attendee's offers `FOR SHARE`, in id order (#1221). A removal from the
 * collection updates the entry's row, and an add-back locks it
 * `FOR UPDATE`, then each writes the nominations it supplies without
 * touching the attendee's row, so only this lock makes the two take turns.
 * Whichever comes second waits, then reads what the first committed: an
 * attendee coming back doesn't resume a nomination of a game removed a moment
 * before, and one leaving pauses a nomination an add-back resumed. The lock
 * order, and why it can't deadlock with a removal, is stated once on
 * `shareLiveEvent`.
 */
export async function syncSuppliedGames(
  tx: Prisma.TransactionClient,
  attendee: Pick<EventAttendee, 'id' | 'eventId' | 'removedAt' | 'status'>,
  now: Date,
): Promise<SuppliedGameChanges> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id = ${attendee.eventId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`
    SELECT c.id
    FROM attendee_game_lists l
    JOIN game_collections c ON c.id = l.collection_id
    WHERE l.attendee_id = ${attendee.id}
    ORDER BY c.id
    FOR SHARE OF c
  `);

  if (!isOutOfEvent(attendee)) {
    // Only a game still in their collection is supplied again (#1221).
    return resumeSupply(tx, { attendeeId: attendee.id, collection: { is: { deletedAt: null } } });
  }

  return pauseSupply(tx, { attendeeId: attendee.id }, now);
}

/**
 * Stops the offers `offers` matches supplying anything: each nomination
 * supplied from one that awaits an outcome pauses, whoever made it, and
 * remembers the status it paused from, and each lineup game one supplies
 * leaves the lineup of every date still ahead ({@link lineupStillAhead}), as
 * of `now`. The half of {@link syncSuppliedGames} and
 * `syncCollectionEntrySupply` that pauses; each caller takes its own locks
 * first.
 */
export async function pauseSupply(
  tx: Prisma.TransactionClient,
  offers: Prisma.EventAttendeeGameListWhereInput,
  now: Date,
): Promise<SuppliedGameChanges> {
  const paused: NominationStatusChange[] = [];

  for (const status of PAUSABLE_STATUSES) {
    const rows = await tx.eventGameNomination.updateManyAndReturn({
      where: { suppliedFrom: { is: offers }, status },
      data: { status: NominationStatus.Paused, pausedFrom: status },
      select: { id: true },
    });
    paused.push(...rows.map((row) => ({ ...row, from: status, to: NominationStatus.Paused })));
  }

  const removedGames = await tx.eventGame.findMany({
    where: { suppliedBy: { is: offers }, ...lineupStillAhead(now) },
    select: LINEUP_GAME_SNAPSHOT_SELECT,
  });

  if (removedGames.length > 0) {
    await tx.eventGame.deleteMany({ where: { id: { in: removedGames.map((game) => game.id) } } });
  }

  return { paused, resumed: [], removedGames };
}

/**
 * Returns each paused nomination supplied from an offer `offers` matches to
 * the status it paused from. The half of {@link syncSuppliedGames} and
 * `syncCollectionEntrySupply` that resumes; each caller takes its own locks
 * first, and narrows `offers` to the ones that supply again.
 */
export async function resumeSupply(
  tx: Prisma.TransactionClient,
  offers: Prisma.EventAttendeeGameListWhereInput,
): Promise<SuppliedGameChanges> {
  const resumed: NominationStatusChange[] = [];

  for (const status of PAUSABLE_STATUSES) {
    const rows = await tx.eventGameNomination.updateManyAndReturn({
      where: { suppliedFrom: { is: offers }, status: NominationStatus.Paused, pausedFrom: status },
      data: { status, pausedFrom: null },
      select: { id: true },
    });
    resumed.push(...rows.map((row) => ({ ...row, from: NominationStatus.Paused, to: status })));
  }

  return { paused: [], resumed, removedGames: [] };
}

/**
 * Runs `write`, a write to an event's dates, and takes off the lineup each
 * game it put back ahead that nobody is bringing: its supplier is out of the
 * event, its entry came off their offered games (#551), or the game was
 * removed from its owner's collection (#1221).
 *
 * Neither takes a game off a date that has started ({@link lineupStillAhead}),
 * and nor does the removal route: it refuses a lineup that has started
 * (#769). Moving that date's start to one still to come, adding a date to an
 * event whose dates have all started, or removing its last date, puts the
 * lineup ahead again with the game still in it. No other write does: a
 * declined or cancelled date never returns to proposed or confirmed.
 *
 * The event's row is locked `FOR NO KEY UPDATE` before the write, so this,
 * a host's removal (`LineupService.removeLineupGame`) and each write that can
 * leave a lineup game with nobody bringing it take turns (`shareLiveEvent`).
 * One that commits first is seen by the read after the write. One that
 * comes second waits for this to commit, then finds the lineup ahead itself.
 * Two date writes to one event take turns the same way. Under the lock, an
 * event that isn't live answers 404 and nothing is written: one deleted
 * while this waited, or whose household is deleted (#1065).
 */
export async function writeEventDates<T>(
  tx: Prisma.TransactionClient,
  eventId: string,
  now: Date,
  write: () => Promise<T>,
): Promise<{ removedGames: LineupGameSnapshot[]; written: T }> {
  await lockLiveEventDates(tx, eventId);

  const written = await write();

  const removedGames = await tx.eventGame.findMany({
    where: {
      suppliedBy: {
        is: {
          attendee: { is: { eventId } },
          OR: [
            { removedAt: { not: null } },
            { attendee: { is: OUT_OF_EVENT } },
            { collection: { is: { deletedAt: { not: null } } } },
          ],
        },
      },
      ...lineupStillAhead(now),
    },
    select: LINEUP_GAME_SNAPSHOT_SELECT,
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
  games: LineupGameSnapshot[],
  reason: LineupRemovalReason,
  actingUserId: string | null,
  initiatedAt: Date,
): void {
  for (const game of games) {
    emitter.emit(
      GameRemovedFromEventEvent.eventName,
      new GameRemovedFromEventEvent(game, eventId, reason, actingUserId, initiatedAt),
    );
  }
}

/**
 * Emits one domain event per row {@link syncSuppliedGames} or
 * `syncCollectionEntrySupply` changed, each lineup game taken off with
 * `reason`. Call it after the transaction commits.
 */
export function emitSuppliedGameChanges(
  emitter: EventEmitter2,
  eventId: string,
  changes: SuppliedGameChanges,
  reason: LineupRemovalReason,
  actingUserId: string | null,
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

  emitRemovedGames(emitter, eventId, changes.removedGames, reason, actingUserId, initiatedAt);
}

/**
 * Emits one domain event per game {@link writeEventDates} took off, as a game
 * nobody is bringing. Call it after the transaction commits.
 */
export function emitGamesNobodyBrings(
  emitter: EventEmitter2,
  eventId: string,
  games: LineupGameSnapshot[],
  actingUserId: string | null,
  initiatedAt: Date,
): void {
  emitRemovedGames(emitter, eventId, games, LineupRemovalReason.NobodyBringing, actingUserId, initiatedAt);
}

/** Whom {@link seatUserWithin} seats on an event, and in which role. */
export interface SeatUserParams {
  /** When the seat is written: the date its `Attending` answer holds (#1027). */
  readonly at: Date;

  readonly eventId: string;

  /**
   * The attendee row of whoever invited or added them, or `null` for someone
   * who attends nothing: a household owner or admin invites through the
   * household's grant without a seat on the event (#742).
   */
  readonly invitedByAttendeeId: string | null;

  readonly roleName: AssignableAttendeeRole;
  readonly userId: string;
}

/** A removed attendee's row as it stood before a seat revived it, as `AttendeeAddedEvent` reports it (#551). */
export type RevivedAttendee = Pick<EventAttendee, 'id' | 'invitedById' | 'removedAt' | 'status'>;

/** What {@link seatUserWithin} wrote, for the caller to answer with and announce once it commits. */
export interface UserSeat {
  readonly attendee: AttendeeRow;

  /** What reviving the row changed in the games they supply; `null` for a new row, which supplies nothing yet. */
  readonly changes: SuppliedGameChanges | null;

  /** The row as it stood before, when the seat revived a removed attendee's; `null` for a new row. */
  readonly revived: RevivedAttendee | null;
}

/**
 * Seats a user with an account on the event, on the caller's transaction:
 * the attendee row, in `roleName`, `Attending`, with its RSVP dated `at`
 * (#1027). Accepting an invite is the only way a user with an account joins,
 * and accepting means attending, so there is no other status to seat with,
 * and no notes (#742). The caller holds the event's lock (`shareLiveEvent`)
 * and has settled whether the user may be seated.
 *
 * Someone a host removed keeps their row, and the (event, user) key with it,
 * so seating them again revives that row rather than inserting a second
 * (#551): it clears `removedAt`, gives them a fresh role, and brings the
 * games they supply back into line ({@link syncSuppliedGames}), so the
 * nominations paused when they left resume. The revive matches only a row
 * still removed.
 *
 * Someone already on the event answers 409, and so does a seat a concurrent
 * write took first: an insert that meets the (event, user) key, or a revive
 * that finds the row no longer removed. Either throws on the caller's
 * transaction, so the rollback undoes whatever it wrote before.
 *
 * An accepted invite (`EventInviteResponder.accept`, #742) seats through
 * here. The direct add places only people without an account, so it never
 * does.
 */
export async function seatUserWithin(tx: Prisma.TransactionClient, params: SeatUserParams): Promise<UserSeat> {
  const { at, eventId, invitedByAttendeeId, roleName, userId } = params;

  const existing = await tx.eventAttendee.findFirst({
    where: { eventId, userId },
    select: { id: true, status: true, invitedById: true, removedAt: true },
  });

  if (existing && existing.removedAt === null) {
    throw new ConflictException(t('errors.attendee.already_attendee'));
  }

  const fields = {
    status: EventParticipationStatus.Attending,
    // The row holds its answer from now, a revived one included (#1027).
    rsvpDate: at,
    role: { create: { role: { connect: { name: roleName } } } },
  };

  const inviter = invitedByAttendeeId === null ? null : { connect: { id: invitedByAttendeeId } };
  let attendee: AttendeeRow;

  try {
    attendee = existing
      ? await tx.eventAttendee.update({
          // Matches nothing once a concurrent write has revived it, which
          // answers as the duplicate it then is.
          where: { id: existing.id, removedAt: { not: null } },
          data: { ...fields, removedAt: null, invitedBy: inviter ?? { disconnect: true } },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        })
      : await tx.eventAttendee.create({
          data: {
            ...fields,
            event: { connect: { id: eventId } },
            user: { connect: { id: userId } },
            invitedBy: inviter ?? undefined,
          },
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
        });
  } catch (error) {
    // Any unique clash on the seat answers 409 already an attendee: the only
    // unique keys the write can hit are the (event, user) key and the role
    // row's. A removal always deletes the role row, so a role clash on a
    // revive cannot happen today (#742).
    if (isPrismaUniqueConstraintError(error) || (existing && isPrismaDependentRecordNotFoundError(error))) {
      throw new ConflictException(t('errors.attendee.already_attendee'));
    }

    throw error;
  }

  if (!existing) {
    return { attendee, changes: null, revived: null };
  }

  return { attendee, changes: await syncSuppliedGames(tx, attendee, at), revived: existing };
}

/**
 * The domain event for an attendee added: create-shaped for a new row,
 * update-shaped for the removed row a seat revived (#551). Emit it after the
 * transaction that wrote the row commits.
 */
export function attendeeAddedEvent(
  revived: RevivedAttendee | null,
  attendee: Pick<EventAttendee, 'eventId' | 'guestName' | 'id' | 'invitedById' | 'removedAt' | 'status' | 'userId'>,
  initiatedAt: Date,
): AttendeeAddedEvent {
  return new AttendeeAddedEvent(
    revived,
    {
      id: attendee.id,
      eventId: attendee.eventId,
      userId: attendee.userId,
      guestName: attendee.guestName,
      status: attendee.status,
      invitedById: attendee.invitedById,
      ...(revived ? { removedAt: attendee.removedAt } : {}),
    },
    initiatedAt,
  );
}
