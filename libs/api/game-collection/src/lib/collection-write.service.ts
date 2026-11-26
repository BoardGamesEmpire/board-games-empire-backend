import type { Action, GameCollection, GameMedium, GameRemovalReason } from '@bge/database';
import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma, ResourceType } from '@bge/database';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import type { AbilityService } from '@bge/permissions';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OWNED_COPY, REMOVED_COPY } from './collection-row';
import { collectionEntryNotFound } from './game-collection.errors';

/** A collection entry as {@link CollectionWriteService.lockEntry} holds it. */
export interface LockedEntry {
  deletedAt: Date | null;
  medium: GameMedium;
  platformGameId: string;
  userId: string;
}

/** What one write of a collection entry did: its answer, and the entry whose copies it may have changed. */
export interface EntryWrite<T> {
  entryId: string;

  /**
   * The reason the entry takes from this write, when the write learns it
   * only under the entry's lock (#1231): a restore of a revision that removes
   * the entry, or a correction of the reason of a copy removed with the
   * entry. Given, it takes the place of the `removeReason` handed to `run`.
   */
  removeReason?: GameRemovalReason | null;

  result: T;
}

/**
 * Writes `data` to the entry, held to the actor's `action` conditions on it
 * and to `state`, inside the write's own `where`, as `PATCH` is (#1288). A
 * miss, whether the entry is outside the conditions or not in `state`,
 * answers `COLLECTION_ENTRY_NOT_FOUND`, as one that doesn't exist does
 * (#634). The entry add, the entry removal and the copy routes share it, so
 * each holds the entry to its conditions the same way.
 */
export async function writeEntryUnder(
  tx: Prisma.TransactionClient,
  abilityService: Pick<AbilityService, 'getCurrentResourceConditions'>,
  id: string,
  action: Action,
  state: Pick<Prisma.GameCollectionWhereInput, 'deletedAt'>,
  data: Prisma.GameCollectionUncheckedUpdateInput,
): Promise<void> {
  try {
    await tx.gameCollection.update({
      where: {
        id,
        ...state,
        // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
        AND: abilityService.getCurrentResourceConditions(ResourceType.GameCollection, action),
      },
      data,
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaDependentRecordNotFoundError(error)) {
      throw collectionEntryNotFound(id);
    }

    throw error;
  }
}

/**
 * The one way a collection entry and its copies are written (#1231).
 *
 * An entry is removed when its last owned copy is, and owned again when it
 * has an owned copy once more, so after every write the entry's removal is
 * brought into line with its copies ({@link reconcileOwnership}), in the same
 * transaction. When that flips the entry, its offers in events follow
 * (`syncCollectionEntrySupply`, #1221): a removal pauses the nominations of
 * its game and takes it off the lineups still ahead, an acquisition resumes
 * what the removal paused. The changes are emitted once the transaction
 * commits.
 *
 * A write's first lock must be the entry's row: {@link lockEntry}, or the
 * add's lock on the entry's identity. The sync then takes turns with every
 * other write that changes what the entry supplies, since each holds the
 * entry's row first (`syncCollectionEntrySupply`). The transaction keeps the
 * default isolation, READ COMMITTED: the sync relies on each of its statements
 * reading what had committed when it started.
 */
@Injectable()
export class CollectionWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Runs `write`, then {@link reconcileOwnership} on the entry it names, in
   * one transaction. When ownership flipped, the entry's offers are synced in
   * that transaction, and the changes emitted after it commits, as
   * `actingUserId`'s. Answers what `write` answered.
   *
   * A copy removal passes its own `removeReason`, which the reconcile gives
   * the entry only when the removal removes it ({@link reconcileOwnership}).
   * A write that learns its reason only under the entry's lock names it in
   * its answer instead ({@link EntryWrite.removeReason}).
   */
  async run<T>(
    write: (tx: Prisma.TransactionClient) => Promise<EntryWrite<T>>,
    actingUserId: string | null,
    now: Date,
    removeReason?: GameRemovalReason | null,
  ): Promise<T> {
    return this.transact(write, async (_tx, { result }) => result, actingUserId, now, removeReason);
  }

  /**
   * {@link run} for a write whose answer is the entry itself. `write` answers
   * the id of the entry it wrote, and the answer is what `read` reads of that
   * entry after its ownership is reconciled, in the same transaction, under
   * the entry's lock: the removal or acquisition the write caused shows, and
   * no later write does (#1231).
   *
   * An entry removal passes its own `removeReason`, which the reconcile gives
   * the entry when it removes it ({@link reconcileOwnership}).
   */
  async runForRow<T>(
    write: (tx: Prisma.TransactionClient) => Promise<string>,
    read: (tx: Prisma.TransactionClient, entryId: string) => Promise<T>,
    actingUserId: string | null,
    now: Date,
    removeReason?: GameRemovalReason | null,
  ): Promise<T> {
    return this.transact(
      async (tx) => ({ entryId: await write(tx), result: null }),
      (tx, { entryId }) => read(tx, entryId),
      actingUserId,
      now,
      removeReason,
    );
  }

  /**
   * Locks the entry's row `FOR UPDATE`, and answers what a write checks it
   * against: the entry's owner, platform game and medium, and whether it is removed.
   * Null when no entry has the id, or, given `ownerId`, none of that user's
   * has it: another user's entry is then never locked (#1231). Make it the
   * transaction's first lock (#1221).
   */
  async lockEntry(tx: Prisma.TransactionClient, entryId: string, ownerId?: string): Promise<LockedEntry | null> {
    const [locked] = await tx.$queryRaw<LockedEntry[]>(Prisma.sql`
      SELECT deleted_at AS "deletedAt", medium, platform_game_id AS "platformGameId", user_id AS "userId"
      FROM game_collections
      WHERE id = ${entryId}${ownerId === undefined ? Prisma.empty : Prisma.sql` AND user_id = ${ownerId}`}
      FOR UPDATE
    `);

    return locked ?? null;
  }

  /**
   * Locks the entry's row as {@link lockEntry} does, once a plain read has
   * found it inside the actor's `action` conditions (#1231). An entry the
   * actor may not write answers `COLLECTION_ENTRY_NOT_FOUND` before anything
   * is locked, so a request for another user's entry never makes its owner's
   * writes wait. The read takes no lock, so the entry's is still the
   * transaction's first (#1221); the write's own `where` still holds the
   * entry to the conditions ({@link writeEntryUnder}).
   */
  async lockEntryUnder(
    tx: Prisma.TransactionClient,
    abilityService: Pick<AbilityService, 'getCurrentResourceConditions'>,
    entryId: string,
    action: Action,
  ): Promise<LockedEntry> {
    const writable = await tx.gameCollection.findFirst({
      where: {
        id: entryId,
        // eslint-disable-next-line no-restricted-syntax -- single-row pre-read for a write by id, not a collection read
        AND: abilityService.getCurrentResourceConditions(ResourceType.GameCollection, action),
      },
      select: { id: true },
    });
    const locked = writable === null ? null : await this.lockEntry(tx, entryId);

    if (locked === null) {
      throw collectionEntryNotFound(entryId);
    }

    return locked;
  }

  /**
   * Brings the entry's removal into line with its copies (#1231), and
   * answers the entry's new state when it flipped, else null:
   *
   * - **No owned copy, the entry live:** the entry is removed now. Its reason
   *   is `removeReason` when the write gives one, as an entry removal does,
   *   an explicit `null` included: the entry's removal is that request's, and
   *   a copy removal that committed while it waited for the entry's lock may
   *   carry a later `removedAt` than its own. Otherwise it is the reason of
   *   the copy that removed it ({@link entryRemovalReason}). A copy taken back
   *   is no removal, so its reason never names the entry's.
   * - **An owned copy, the entry removed:** its removal clears.
   * - **No owned copy, the entry removed already:** it stays removed. A write
   *   that gives a `removeReason`, as a correction of the reason of a copy
   *   removed with the entry does, gives the entry that reason, whichever of
   *   the copies removed with it was corrected. Any other write keeps the
   *   entry's reason while a copy removed with the entry still carries it,
   *   and else reads it again from the copies ({@link entryRemovalReason}).
   *
   * It always sets `lastUpdated`, which bumps `updatedAt`, so the
   * `updatedSince` catch-up resends the row after any write of its copies
   * (`changedSince`).
   */
  async reconcileOwnership(
    tx: Prisma.TransactionClient,
    entryId: string,
    now: Date,
    removeReason?: GameRemovalReason | null,
  ): Promise<Pick<GameCollection, 'id' | 'deletedAt'> | null> {
    const entry = await tx.gameCollection.findUniqueOrThrow({
      where: { id: entryId },
      select: { deleteReason: true, deletedAt: true, _count: { select: { copies: { where: OWNED_COPY } } } },
    });
    const owned = entry._count.copies;

    if (owned === 0 && entry.deletedAt === null) {
      await this.writeEntry(tx, entryId, {
        deletedAt: now,
        deleteReason: removeReason === undefined ? await this.entryRemovalReason(tx, entryId, now) : removeReason,
        lastUpdated: now,
      });

      return { id: entryId, deletedAt: now };
    }

    if (owned > 0 && entry.deletedAt !== null) {
      await this.writeEntry(tx, entryId, { deletedAt: null, deleteReason: null, lastUpdated: now });

      return { id: entryId, deletedAt: null };
    }

    if (owned === 0 && entry.deletedAt !== null) {
      await this.writeEntry(tx, entryId, {
        deleteReason:
          removeReason === undefined
            ? await this.entryRemovalReason(tx, entryId, entry.deletedAt, entry.deleteReason)
            : removeReason,
        lastUpdated: now,
      });

      return null;
    }

    await this.writeEntry(tx, entryId, { lastUpdated: now });

    return null;
  }

  /**
   * The reason of the copy whose removal removed the entry at `deletedAt`, or
   * null when it gave none (#1231): the one definition both the flip and the
   * re-read use, so they agree.
   *
   * Every write that removes an entry stamps the copy's `removedAt` and the
   * entry's `deletedAt` from the same `now`, and so does the migration's
   * backfill, so that copy is the one removed at `deletedAt`. The latest
   * `removedAt` is not: a racing copy removal may commit a later stamp while
   * its request waits for the entry's lock. When no copy was removed at that
   * instant, the copy removed last stands in.
   *
   * Several copies removed with the entry may carry different reasons once
   * one is corrected, so the entry's `current` reason, when given, stands
   * while one of them still carries it: an edit of another of them doesn't
   * take it back. Otherwise the copy created last among them names it.
   */
  private async entryRemovalReason(
    tx: Prisma.TransactionClient,
    entryId: string,
    deletedAt: Date,
    current?: GameRemovalReason | null,
  ): Promise<GameRemovalReason | null> {
    if (
      current !== undefined &&
      (await tx.collectionCopy.count({
        where: { entryId, removedAt: deletedAt, removeReason: current, AND: REMOVED_COPY },
      })) > 0
    ) {
      return current;
    }

    const select = { removeReason: true } as const;
    const latestFirst: Prisma.CollectionCopyOrderByWithRelationInput[] = [{ removedAt: 'desc' }, { createdAt: 'desc' }];
    const removedWithEntry = await tx.collectionCopy.findFirst({
      where: { entryId, removedAt: deletedAt, AND: REMOVED_COPY },
      orderBy: latestFirst,
      select,
    });
    const removing =
      removedWithEntry ??
      (await tx.collectionCopy.findFirst({ where: { entryId, AND: REMOVED_COPY }, orderBy: latestFirst, select }));

    return removing?.removeReason ?? null;
  }

  /**
   * The transaction every write runs in: `write`, the reconcile, the sync on
   * a flip, then `answer`. The emit waits for the commit, so no listener
   * hears of a change that rolled back.
   */
  private async transact<W extends EntryWrite<unknown>, T>(
    write: (tx: Prisma.TransactionClient) => Promise<W>,
    answer: (tx: Prisma.TransactionClient, written: W) => Promise<T>,
    actingUserId: string | null,
    now: Date,
    removeReason?: GameRemovalReason | null,
  ): Promise<T> {
    const { answered, supplyChanges } = await this.db.$transaction(async (tx) => {
      const written = await write(tx);
      const flipped = await this.reconcileOwnership(
        tx,
        written.entryId,
        now,
        written.removeReason === undefined ? removeReason : written.removeReason,
      );
      const synced: CollectionSupplyChange[] | null =
        flipped === null ? null : await syncCollectionEntrySupply(tx, flipped, now);

      return { answered: await answer(tx, written), supplyChanges: synced };
    });

    if (supplyChanges !== null) {
      emitCollectionSupplyChanges(this.eventEmitter, supplyChanges, actingUserId, now);
    }

    return answered;
  }

  private async writeEntry(
    tx: Prisma.TransactionClient,
    entryId: string,
    data: Prisma.GameCollectionUncheckedUpdateInput,
  ): Promise<void> {
    await tx.gameCollection.update({ where: { id: entryId }, data, select: { id: true } });
  }
}
