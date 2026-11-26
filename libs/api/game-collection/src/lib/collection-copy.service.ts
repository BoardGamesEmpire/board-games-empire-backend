import type { Prisma } from '@bge/database';
import { Action, DatabaseService, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { pickDefined } from '@bge/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertCopyRoom, copyColumns, copyCreateData } from './collection-copy-data';
import { OWNED_COPY, OWNER_COPY_SELECT } from './collection-row';
import type { LockedEntry } from './collection-write.service';
import { CollectionWriteService, writeEntryUnder } from './collection-write.service';
import type {
  CollectionCopyDto,
  CreateCollectionCopyDto,
  RemoveCollectionCopyQueryDto,
  UpdateCollectionCopyDto,
} from './dto';
import { toCollectionCopyDto } from './dto';
import { collectionEntryNotFound, copyNotFound, copyStillOwned } from './game-collection.errors';
import { assertRemovalAfterAcquisition, partialDateFromColumns, removalDate } from './values/partial-date';

/**
 * The copies of a collection entry, on its owner's routes (#1231).
 *
 * Each write runs through `CollectionWriteService`, whose reconcile removes
 * the entry with its last owned copy and acquires it again with a new one,
 * and whose sync then pauses or resumes the entry's offers in events (#1221).
 * Its first statement locks the entry's row, so it takes turns with every
 * other write that changes what the entry supplies. The entry is then held to
 * the actor's `update` conditions, as `PATCH /game-collections/:id` is: each
 * copy write is an update of the entry (#1288). A miss answers
 * `COLLECTION_ENTRY_NOT_FOUND`, as an entry that doesn't exist does (#634).
 */
@Injectable()
export class CollectionCopyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly writes: CollectionWriteService,
  ) {}

  /**
   * Every copy of the acting user's own entry, removed ones included, oldest
   * first (#1231). A copy's acquisition and price are the owner's alone,
   * whatever the entry's reach, so the entry is read as the actor's own, under
   * their read conditions: anyone else, and an actor that is no user, gets
   * `COLLECTION_ENTRY_NOT_FOUND`.
   */
  async list(entryId: string): Promise<CollectionCopyDto[]> {
    const userId = resolveActingUserIdOrNull(this.abilityService);

    if (userId === null) {
      throw collectionEntryNotFound(entryId);
    }

    const entry = await this.db.gameCollection.findUnique({
      where: {
        id: entryId,
        userId,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read),
      },
      select: { copies: { select: OWNER_COPY_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });

    if (entry === null) {
      throw collectionEntryNotFound(entryId);
    }

    return entry.copies.map(toCollectionCopyDto);
  }

  /**
   * Adds a copy to the entry, described by `dto` (#1231). An entry holds at
   * most `COLLECTION_COPY_LIMIT` copies, counting every state, checked under
   * the entry's lock. A copy added to a removed entry acquires it again.
   */
  async add(entryId: string, dto: CreateCollectionCopyDto): Promise<CollectionCopyDto> {
    const now = new Date();

    return this.writes.run(
      async (tx) => {
        const entry = await this.lockedForUpdate(tx, entryId, now);
        await assertCopyRoom(tx, entryId);

        const copy = await tx.collectionCopy.create({
          data: { entryId, ...(await copyCreateData(tx, dto, entry, now)) },
          select: OWNER_COPY_SELECT,
        });

        return { entryId, result: toCollectionCopyDto(copy) };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
    );
  }

  /**
   * Corrects one copy of the entry (#1231): the fields `dto` names, under the
   * add's rules, and `null` clears a field. `removedOn` and `removeReason`
   * change a removal, so only a removed copy takes them (`COLLECTION_COPY_OWNED`).
   * The removal must not end before the acquisition, as the copy will hold
   * them both (`COLLECTION_DATE_ORDER`). Each edit stamps `editedByUserAt`,
   * so a sync leaves the copy as the user left it. On a removed entry, a
   * corrected removal reason reaches the entry's own reason through the
   * write runner's reconcile.
   */
  async update(entryId: string, copyId: string, dto: UpdateCollectionCopyDto): Promise<CollectionCopyDto> {
    if (Object.keys(pickDefined(dto)).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const { removedOn, removeReason, ...described } = dto;
    const now = new Date();
    const newRemoval = removedOn === undefined ? null : removalDate(removedOn, now);

    return this.writes.run(
      async (tx) => {
        const entry = await this.lockedForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId },
          select: {
            acquiredOn: true,
            acquiredOnPrecision: true,
            removedAt: true,
            removedOn: true,
            removedOnPrecision: true,
          },
        });

        if (copy === null) {
          throw copyNotFound(copyId);
        }

        if ((removedOn !== undefined || removeReason !== undefined) && copy.removedAt === null) {
          throw copyStillOwned();
        }

        const columns = await copyColumns(tx, described, entry, now);
        const removal = newRemoval ?? partialDateFromColumns(copy.removedOn, copy.removedOnPrecision);
        const acquisition =
          columns.acquiredOn === undefined
            ? partialDateFromColumns(copy.acquiredOn, copy.acquiredOnPrecision)
            : partialDateFromColumns(columns.acquiredOn, columns.acquiredOnPrecision ?? null);
        assertRemovalAfterAcquisition(acquisition, removal);

        const edited = await tx.collectionCopy.update({
          where: { id: copyId },
          data: {
            ...columns,
            ...(newRemoval === null ? {} : { removedOn: newRemoval.on, removedOnPrecision: newRemoval.precision }),
            ...(removeReason !== undefined ? { removeReason } : {}),
            editedByUserAt: now,
          },
          select: OWNER_COPY_SELECT,
        });

        return { entryId, result: toCollectionCopyDto(edited) };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
    );
  }

  /**
   * Removes one copy the user still owns, dated `removedOn`, or today in UTC
   * when the user gives no date, with the reason (#1231). A copy missing,
   * already removed or taken back answers `COLLECTION_COPY_NOT_FOUND`.
   *
   * Removing the entry's last owned copy removes the entry, so it is also
   * held to the entry's `delete` permission (#1288). The write runner then
   * removes the entry with this removal's reason, handed to it rather than
   * read back from the copies, so a removal stamped later by a racing request
   * can't lend the entry its own; and it pauses the entry's offers in events,
   * as `DELETE /game-collections/:id` does (#1221).
   *
   * A removal is the user's word on the copy, so it stamps `editedByUserAt`,
   * and a sync leaves the removed copy as it is (#1231).
   */
  async remove(
    entryId: string,
    copyId: string,
    { reason, removedOn }: RemoveCollectionCopyQueryDto,
  ): Promise<CollectionCopyDto> {
    const now = new Date();
    const removal = removalDate(removedOn, now);

    return this.writes.run(
      async (tx) => {
        const entry = await this.lockedForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId, AND: OWNED_COPY },
          select: { acquiredOn: true, acquiredOnPrecision: true },
        });

        if (copy === null) {
          throw copyNotFound(copyId);
        }

        if ((await tx.collectionCopy.count({ where: { entryId, ...OWNED_COPY } })) === 1) {
          this.abilityService.assertCurrentActorCan(Action.delete, ResourceType.GameCollection, {
            id: entryId,
            ...entry,
          });
        }

        assertRemovalAfterAcquisition(partialDateFromColumns(copy.acquiredOn, copy.acquiredOnPrecision), removal);

        const removed = await tx.collectionCopy.update({
          where: { id: copyId },
          data: {
            removedAt: now,
            removedOn: removal.on,
            removedOnPrecision: removal.precision,
            removeReason: reason ?? null,
            editedByUserAt: now,
          },
          select: OWNER_COPY_SELECT,
        });

        return { entryId, result: toCollectionCopyDto(removed) };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
      reason ?? null,
    );
  }

  /**
   * Locks the entry's row, as the transaction's first lock (#1221), then
   * holds it to the actor's `update` conditions (#1288). Answers what the
   * copy is checked against: the entry's medium and platform game.
   */
  private async lockedForUpdate(tx: Prisma.TransactionClient, entryId: string, now: Date): Promise<LockedEntry> {
    const locked = await this.writes.lockEntry(tx, entryId);

    if (locked === null) {
      throw collectionEntryNotFound(entryId);
    }

    await writeEntryUnder(tx, this.abilityService, entryId, Action.update, {}, { lastUpdated: now });

    return locked;
  }
}
