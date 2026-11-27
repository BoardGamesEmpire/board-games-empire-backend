import type { Prisma } from '@bge/database';
import {
  Action,
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  normalizeClientRequestId,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { pickDefined } from '@bge/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  addCopy,
  assertRemovableOn,
  copyColumns,
  copyRemovalData,
  REMOVAL_CHECK_SELECT,
  removalOf,
  writingRelease,
} from './collection-copy-data';
import type { OwnerCopyRow } from './collection-row';
import { COPY_ORDER, OWNED_COPY, OWNER_COPY_SELECT, readOwnEntry, removedWithEntry } from './collection-row';
import type { LockedEntry } from './collection-write.service';
import { CollectionWriteService, writeEntryUnder } from './collection-write.service';
import type {
  CollectionCopyDto,
  CreateCollectionCopyDto,
  RemoveCollectionCopyQueryDto,
  UpdateCollectionCopyDto,
} from './dto';
import { toCollectionCopyDto } from './dto';
import { collectionEntryNotFound, copyNotFound, copyNotRemoved } from './game-collection.errors';
import { assertRemovalAfterAcquisition, givenRemovalDate, partialDateFromColumns } from './values/partial-date';

/**
 * The unique that keeps one copy per client request id on an entry, in every
 * spelling a P2002 identity reports it (see `identifiesConstraint`): the index
 * name, the raw columns, and the Prisma fields (#1231, #252).
 */
const COPY_KEY_SPELLINGS = [
  ['collection_copy_entry_client_request_id_unique'],
  ['entry_id', 'client_request_id'],
  ['entryId', 'clientRequestId'],
] as const;

/**
 * Whether `error` is a unique violation on a copy's client request id: a
 * repeat of the add that committed first (#252). One whose constraint can't
 * be named counts, when the add was keyed: a copy's only other unique is its
 * upstream account's key, which no add on these routes sets.
 */
function isCopyKeyViolation(error: unknown): boolean {
  const identity = constraintIdentity(error);

  return identity.source === 'unknown' || identifiesConstraint(identity, ...COPY_KEY_SPELLINGS);
}

/**
 * The copies of a collection entry, on the routes only the entry's owner
 * uses (#1231).
 *
 * Each write runs through `CollectionWriteService`, whose reconcile removes
 * the entry with its last owned copy and acquires it again with a new one,
 * and whose sync then pauses or resumes the entry's offers in events (#1221).
 * Its first statement locks the entry's row, so it takes turns with every
 * other write that changes what the entry supplies. The entry must then be
 * the acting user's own, and is held to the actor's `update` conditions, as
 * `PATCH /game-collections/:id` is: each copy write is an update of the entry
 * (#1288). A miss answers `COLLECTION_ENTRY_NOT_FOUND`, as an entry that
 * doesn't exist does (#634).
 *
 * Every route here is the entry owner's alone, the writes as much as the
 * list: each write answers the copy as the entry's owner reads it, its price,
 * value, acquisition and note, which no one else may read, whatever their
 * grants (#1231). A role holding every permission still writes no one's
 * copies but its own user's. A plugin has no user, so it writes no copies at
 * all. An API key acts for the user who made it, so it writes that user's.
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
   * first (#1231). A copy's acquisition and price are yours alone, whatever
   * the entry's reach, so the entry is read as your own (`readOwnEntry`).
   */
  async list(entryId: string): Promise<CollectionCopyDto[]> {
    const entry = await readOwnEntry(this.db, this.abilityService, entryId, {
      copies: { select: OWNER_COPY_SELECT, orderBy: COPY_ORDER },
    });

    return entry.copies.map(toCollectionCopyDto);
  }

  /**
   * Adds a copy to the entry, described by `dto` (#1231). An entry holds at
   * most `COLLECTION_COPY_LIMIT` copies the user owns, checked under the
   * entry's lock; removed and taken-back ones don't count. A copy added to a
   * removed entry acquires it again.
   *
   * Keyed by `clientRequestId` (ADR 0002, #252): a repeat under a key the
   * entry already holds answers the copy that key made, as it stands now,
   * removed or taken back since included, whatever the repeat's body says.
   * It adds nothing, so it never meets the cap. The key is looked up under
   * the entry's lock and after the checks that it is your entry and that you
   * may update it, the route's own checks, so a key is no way past them.
   *
   * Two repeats wait for the entry's lock in turn, and the second finds the
   * first's copy. Should a repeat still trip the key's unique, the add runs
   * once more, in a transaction of its own, and finds the copy the other
   * committed, as `createOrReplay` does: Postgres aborts the transaction the
   * violation happened in, so nothing inside it can look again.
   */
  async add(entryId: string, dto: CreateCollectionCopyDto): Promise<CollectionCopyDto> {
    const { clientRequestId: sentKey, ...description } = dto;
    const clientRequestId = normalizeClientRequestId(sentKey);
    const now = new Date();

    const attempt = () =>
      this.writes.run(
        async (tx) => {
          const entry = await this.lockOwnEntryAndStampUpdate(tx, entryId, now);
          const replayed = clientRequestId === undefined ? null : await this.copyUnderKey(tx, entryId, clientRequestId);
          const copy = replayed ?? (await addCopy(tx, { ...entry, id: entryId }, description, now, clientRequestId));

          return { entryId, result: toCollectionCopyDto(copy) };
        },
        resolveActingUserIdOrNull(this.abilityService),
        now,
      );

    try {
      return await attempt();
    } catch (error) {
      if (clientRequestId === undefined || !isCopyKeyViolation(error)) {
        throw error;
      }

      return attempt();
    }
  }

  /** The copy the entry's add under `clientRequestId` made, in any state, or null (#252). */
  private async copyUnderKey(
    tx: Prisma.TransactionClient,
    entryId: string,
    clientRequestId: string,
  ): Promise<OwnerCopyRow | null> {
    return tx.collectionCopy.findUnique({
      where: { entryId_clientRequestId: { entryId, clientRequestId } },
      select: OWNER_COPY_SELECT,
    });
  }

  /**
   * Corrects one copy of the entry (#1231): the fields `dto` names, under the
   * add's rules, and `null` clears a field. `removedOn` and `removeReason`
   * change a removal, so only a removed copy takes them (`COLLECTION_COPY_NOT_REMOVED`).
   * The removal must not end before the acquisition, as the copy will hold
   * them both (`COLLECTION_DATE_ORDER`). Each edit stamps `editedByUserAt`,
   * so a sync leaves the copy as the user left it. On a removed entry, a
   * corrected removal reason of a copy removed with the entry becomes the
   * entry's own reason, through the write runner's reconcile, whichever of
   * those copies it is.
   */
  async update(entryId: string, copyId: string, dto: UpdateCollectionCopyDto): Promise<CollectionCopyDto> {
    if (Object.keys(pickDefined(dto)).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const { removedOn, removeReason, ...described } = dto;
    const now = new Date();
    const newRemoval = givenRemovalDate(removedOn, now);

    return this.writes.run(
      async (tx) => {
        const entry = await this.lockOwnEntryAndStampUpdate(tx, entryId, now);
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
          throw copyNotRemoved();
        }

        const columns = await copyColumns(tx, described, entry, now);
        const removal = newRemoval ?? partialDateFromColumns(copy.removedOn, copy.removedOnPrecision);
        const acquisition =
          columns.acquiredOn === undefined
            ? partialDateFromColumns(copy.acquiredOn, copy.acquiredOnPrecision)
            : partialDateFromColumns(columns.acquiredOn, columns.acquiredOnPrecision ?? null);
        assertRemovalAfterAcquisition(acquisition, removal);

        const edited = await writingRelease(described.releaseId, () =>
          tx.collectionCopy.update({
            where: { id: copyId },
            data: {
              ...columns,
              ...(newRemoval === null ? {} : { removedOn: newRemoval.on, removedOnPrecision: newRemoval.precision }),
              ...(removeReason !== undefined ? { removeReason } : {}),
              editedByUserAt: now,
            },
            select: OWNER_COPY_SELECT,
          }),
        );

        return {
          entryId,
          result: toCollectionCopyDto(edited),
          ...(removeReason !== undefined && removedWithEntry(copy, entry) ? { removeReason } : {}),
        };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
    );
  }

  /**
   * Removes one copy the user still owns, dated `removedOn`, or when the user
   * gives no date, today in UTC, or the copy's acquisition day when that is
   * later (`removalOf`), with the reason (#1231). A copy missing,
   * already removed or taken back answers `COLLECTION_COPY_NOT_FOUND`.
   *
   * Removing the entry's last owned copy removes the entry, so it is also
   * held to the entry's `delete` permission (#1288). The write runner then
   * removes the entry with this removal's reason, handed to it rather than
   * read back from the copies, so a removal stamped later by a racing request
   * can't lend the entry its own; and it pauses the entry's offers in events,
   * as `DELETE /game-collections/:id` does (#1221).
   *
   * A removal is the user's word on the copy, so it stamps `editedByUserAt`
   * (`copyRemovalData`), and a sync leaves the removed copy as it is (#1231).
   */
  async remove(
    entryId: string,
    copyId: string,
    { reason, removedOn }: RemoveCollectionCopyQueryDto,
  ): Promise<CollectionCopyDto> {
    const now = new Date();
    const given = givenRemovalDate(removedOn, now);

    return this.writes.run(
      async (tx) => {
        const entry = await this.lockOwnEntryAndStampUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId, AND: OWNED_COPY },
          select: REMOVAL_CHECK_SELECT,
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

        const removal = removalOf(copy, given, now);
        assertRemovableOn(copy, removal);

        const removed = await tx.collectionCopy.update({
          where: { id: copyId },
          data: copyRemovalData(removal, reason, now),
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
   * Locks the entry's row, as the transaction's first lock (#1221), only when
   * it is the acting user's own (#1231), so a request for another user's
   * entry never makes its owner's writes wait, and writes its `lastUpdated`
   * under the actor's `update` conditions (#1288): each copy write is an
   * update of the entry. Another user's entry, or any entry for an actor that
   * is no user, answers `COLLECTION_ENTRY_NOT_FOUND` before anything is read
   * or written, as the list does: the write's answer is the copy as the
   * entry's owner reads it. Answers what the copy is checked against: the
   * entry's medium and platform game.
   */
  private async lockOwnEntryAndStampUpdate(
    tx: Prisma.TransactionClient,
    entryId: string,
    now: Date,
  ): Promise<LockedEntry> {
    const actingUserId = resolveActingUserIdOrNull(this.abilityService);
    const locked = actingUserId === null ? null : await this.writes.lockEntry(tx, entryId, actingUserId);

    if (locked === null) {
      throw collectionEntryNotFound(entryId);
    }

    await writeEntryUnder(tx, this.abilityService, entryId, Action.update, {}, { lastUpdated: now });

    return locked;
  }
}
