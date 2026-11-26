import type { Action, GameCollection, GameMedium, GameRemovalReason } from '@bge/database';
import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma, ResourceType } from '@bge/database';
import type { CollectionSupplyChange } from '@bge/event';
import { emitCollectionSupplyChanges, syncCollectionEntrySupply } from '@bge/event';
import type { AbilityService } from '@bge/permissions';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { GameCollectionWithRelations } from './collection-row';
import { COLLECTION_INCLUDE, OWNED_COPY } from './collection-row';
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
   * the id of the entry it wrote, and the answer is that entry, read with
   * `COLLECTION_INCLUDE` after its ownership is reconciled, in the same
   * transaction: the removal or acquisition the write caused shows, and no
   * later write does.
   *
   * An entry removal passes its own `removeReason`, which the reconcile gives
   * the entry when it removes it ({@link reconcileOwnership}).
   */
  async runForRow(
    write: (tx: Prisma.TransactionClient) => Promise<string>,
    actingUserId: string | null,
    now: Date,
    removeReason?: GameRemovalReason | null,
  ): Promise<GameCollectionWithRelations> {
    return this.transact(
      async (tx) => ({ entryId: await write(tx), result: null }),
      (tx, { entryId }) => tx.gameCollection.findUniqueOrThrow({ where: { id: entryId }, include: COLLECTION_INCLUDE }),
      actingUserId,
      now,
      removeReason,
    );
  }

  /**
   * Locks the entry's row `FOR UPDATE`, and answers what a write checks it
   * against: its owner, platform game and medium, and whether it is removed.
   * Null when no entry has the id. Make it the transaction's first lock
   * (#1221).
   */
  async lockEntry(tx: Prisma.TransactionClient, entryId: string): Promise<LockedEntry | null> {
    const [locked] = await tx.$queryRaw<LockedEntry[]>(Prisma.sql`
      SELECT deleted_at AS "deletedAt", medium, platform_game_id AS "platformGameId", user_id AS "userId"
      FROM game_collections
      WHERE id = ${entryId}
      FOR UPDATE
    `);

    return locked ?? null;
  }

  /**
   * Brings the entry's removal into line with its copies (#1231), and
   * answers the entry's new state when it flipped, else null:
   *
   * - **No owned copy, the entry live:** the entry is removed now. Its reason
   *   is `removeReason` when the write gives one, as an entry removal does,
   *   an explicit `null` included: the entry's removal is that request's, and
   *   a copy removal that committed while it waited for the entry's lock may
   *   carry a later `removedAt` than its own. Otherwise, after a copy's own
   *   removal, it is the reason of the copy removed last. A copy taken back
   *   is no removal, so its reason never names the entry's.
   * - **An owned copy, the entry removed:** its removal clears.
   * - **No owned copy, the entry removed already:** it stays removed. When the
   *   write gives no `removeReason`, as a copy edit doesn't, the entry's
   *   reason is read again from the copy removed last, so a corrected
   *   removal reason on that copy reaches the entry's summary too.
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
      select: { deletedAt: true, _count: { select: { copies: { where: OWNED_COPY } } } },
    });
    const owned = entry._count.copies;

    if (owned === 0 && entry.deletedAt === null) {
      await this.writeEntry(tx, entryId, {
        deletedAt: now,
        deleteReason: removeReason === undefined ? await this.lastRemovalReason(tx, entryId) : removeReason,
        lastUpdated: now,
      });

      return { id: entryId, deletedAt: now };
    }

    if (owned > 0 && entry.deletedAt !== null) {
      await this.writeEntry(tx, entryId, { deletedAt: null, deleteReason: null, lastUpdated: now });

      return { id: entryId, deletedAt: null };
    }

    if (owned === 0 && entry.deletedAt !== null && removeReason === undefined) {
      await this.writeEntry(tx, entryId, { deleteReason: await this.lastRemovalReason(tx, entryId), lastUpdated: now });

      return null;
    }

    await this.writeEntry(tx, entryId, { lastUpdated: now });

    return null;
  }

  /** The reason of the entry's copy removed last, or null when it gave none (#1231). */
  private async lastRemovalReason(tx: Prisma.TransactionClient, entryId: string): Promise<GameRemovalReason | null> {
    const lastRemoved = await tx.collectionCopy.findFirst({
      where: { entryId, removedAt: { not: null }, retractedAt: null },
      orderBy: [{ removedAt: 'desc' }, { createdAt: 'desc' }],
      select: { removeReason: true },
    });

    return lastRemoved?.removeReason ?? null;
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
      const flipped = await this.reconcileOwnership(tx, written.entryId, now, removeReason);
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
