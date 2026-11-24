import type { GameCollection } from '@bge/database';
import { liveEventWhere, Prisma } from '@bge/database';
import { LineupRemovalReason } from '@bge/notifications-service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { SuppliedGameChanges } from './attendance';
import { emitSuppliedGameChanges, IN_EVENT, pauseSupply, resumeSupply } from './attendance';

/** What {@link syncCollectionEntrySupply} changed in one event, for the caller to emit once it commits. */
export interface CollectionSupplyChange {
  readonly changes: SuppliedGameChanges;
  readonly eventId: string;
}

/**
 * Brings the games a collection entry supplies into line with whether it is
 * in its owner's collection, in every live event that offers it (#1221).
 *
 * - **Removed:** each nomination of the game that awaits an outcome pauses,
 *   whoever made it, and remembers the status it paused from. Its votes
 *   stay. The game leaves the lineup of every date still ahead
 *   (`lineupStillAhead`), as of `now`, and is not put back when the
 *   game is added back: by then the host may have filled the slot.
 * - **Added back:** each paused nomination of the game returns to the status
 *   it paused from, if the attendee offering it is in the event. One whose
 *   attendee is out stays paused until they are back
 *   (`syncSuppliedGames`).
 *
 * Only a live event changes (`liveEventWhere`). One that is deleted, or whose
 * household is deleted, keeps its nominations and lineup as they stand.
 *
 * It reads the entry's state as given, not the change that led to it, so
 * running it twice changes nothing. It returns only the events where
 * something changed, for the caller to emit once it commits
 * ({@link emitCollectionSupplyChanges}).
 *
 * Run it in the transaction that removed the entry or added it back, AFTER
 * that transaction locked the entry's row: a removal's `UPDATE` of it, or an
 * add-back's `FOR UPDATE` before its write. That lock is what makes this
 * take turns with every other write that changes what the entry supplies,
 * since each holds the entry's row `FOR SHARE` first: a nomination, a direct
 * add, or adding a nomination's game to the lineup, each naming the offer
 * (`lockSupplier`), and an attendee leaving or coming back
 * (`syncSuppliedGames`). Whichever comes second waits, then reads what the
 * first committed. Without it, this would miss a
 * nomination opened, or an attendee coming back, in a transaction still open
 * when it reads: under READ COMMITTED each statement here reads what had
 * committed when it started, and an update waits only on the rows that match
 * in that read. An offer made after the first read supplies nothing yet,
 * since anything naming it waits on the entry's row.
 *
 * Then it locks each event that offers the entry `FOR SHARE`, all of them
 * before any nomination: removing a date writes to the nominations that name
 * it while holding the event's row, so locking a nomination first could
 * deadlock with it. The database takes them in ascending id order, so any
 * two writes that lock several events lock them in one order. The same lock
 * holds each event's dates while this judges which lineups are still ahead,
 * and holds off the event's delete, so the read for live events under it is
 * the one that counts (#1065). A household's delete locks no event row: a
 * removal that read the household live counts as happening before it.
 *
 * It never locks an attendee's row or an offer's. The lock order, and why
 * it can't deadlock with a supply check or an attendee leaving or coming
 * back, is stated once on `shareLiveEvent`.
 */
export async function syncCollectionEntrySupply(
  tx: Prisma.TransactionClient,
  entry: Pick<GameCollection, 'id' | 'deletedAt'>,
  now: Date,
): Promise<CollectionSupplyChange[]> {
  const offering = await tx.event.findMany({
    where: { attendees: { some: { availableGames: { some: { collectionId: entry.id, removedAt: null } } } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  if (offering.length === 0) {
    return [];
  }

  const ids = offering.map(({ id }) => id);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM events WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`);

  const live = await tx.event.findMany({
    where: { id: { in: ids }, ...liveEventWhere() },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const supplyChanges: CollectionSupplyChange[] = [];

  for (const { id: eventId } of live) {
    // An attendee out of the event supplies nothing, so on an add-back their
    // nominations stay paused until they are back (#1221).
    const changes =
      entry.deletedAt === null
        ? await resumeSupply(tx, { collectionId: entry.id, attendee: { is: { eventId, ...IN_EVENT } } })
        : await pauseSupply(tx, { collectionId: entry.id, attendee: { is: { eventId } } }, now);

    if (changes.paused.length > 0 || changes.resumed.length > 0 || changes.removedGames.length > 0) {
      supplyChanges.push({ eventId, changes });
    }
  }

  return supplyChanges;
}

/**
 * Emits one domain event per row {@link syncCollectionEntrySupply} changed,
 * each lineup game taken off as removed from its supplier's collection.
 * Call it after the transaction commits.
 */
export function emitCollectionSupplyChanges(
  emitter: EventEmitter2,
  changes: readonly CollectionSupplyChange[],
  actingUserId: string | null,
  initiatedAt: Date,
): void {
  for (const change of changes) {
    emitSuppliedGameChanges(
      emitter,
      change.eventId,
      change.changes,
      LineupRemovalReason.RemovedFromCollection,
      actingUserId,
      initiatedAt,
    );
  }
}
