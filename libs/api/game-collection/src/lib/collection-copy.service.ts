import type { Prisma } from '@bge/database';
import { Action, DatabaseService, normalizeClientRequestId, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { pickDefined } from '@bge/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  addCopy,
  assertCopyRoom,
  assertRemovableOn,
  copyColumns,
  copyRemovalData,
  removalOf,
  writingRelease,
} from './collection-copy-data';
import type { CopyRevisionValues } from './collection-revisions';
import {
  COPY_REVISION_SELECT,
  copyRevisionValuesSchema,
  isAlreadyTakenBackAs,
  readableRevisions,
  recordCopyRevision,
  restorableRelease,
  restorableValues,
  restoredCopyOf,
  REVISION_LIST_READ,
  takeBackData,
} from './collection-revisions';
import type { OwnerCopyRow } from './collection-row';
import { COPY_ORDER, OWNED_COPY, OWNER_COPY_SELECT, readOwnEntry, removedWithEntry } from './collection-row';
import type { LockedEntry } from './collection-write.service';
import { CollectionWriteService, retryKeyedAdd } from './collection-write.service';
import type {
  CollectionCopyDto,
  CollectionCopyRevisionDto,
  CollectionReleaseSummaryDto,
  CreateCollectionCopyDto,
  RemoveCollectionCopyQueryDto,
  UpdateCollectionCopyDto,
} from './dto';
import { toCollectionCopyDto, toCollectionCopyRevisionDto } from './dto';
import { copyNotFound, copyNotRemoved, lastCopyTakeBack } from './game-collection.errors';
import {
  assertNotInFuture,
  assertRemovalAfterAcquisition,
  partialDateFromColumns,
  sentDate,
} from './values/partial-date';

/**
 * The unique that keeps one copy per client request id on an entry, in every
 * spelling a P2002 identity reports it (see `retryKeyedAdd`): the index
 * name, the raw columns, and the Prisma fields (#1231, #252).
 */
const COPY_KEY_SPELLINGS = [
  ['collection_copy_entry_client_request_id_unique'],
  ['entry_id', 'client_request_id'],
  ['entryId', 'clientRequestId'],
] as const;

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
  private readonly logger = new Logger(CollectionCopyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly writes: CollectionWriteService,
  ) {}

  /**
   * Every copy of the acting user's own entry, removed and taken-back ones
   * included, oldest first (#1231): a taken-back copy is listed, with its
   * `retractedAt`, so you can undo the take-back. A copy's acquisition
   * and price are yours alone, whatever the entry's reach, so the entry is
   * read as your own (`readOwnEntry`).
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
   * entry's lock; removed and taken-back ones don't count. A restore or an
   * undone take-back that makes a copy owned again is held to the same cap.
   * A copy added to a removed entry acquires it again.
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
   * once more and finds the copy the other committed (`retryKeyedAdd`).
   */
  async add(entryId: string, dto: CreateCollectionCopyDto): Promise<CollectionCopyDto> {
    const { clientRequestId: sentKey, ...description } = dto;
    const clientRequestId = normalizeClientRequestId(sentKey);
    const now = new Date();

    return retryKeyedAdd(
      () =>
        this.writes.run(
          async (tx) => {
            const entry = await this.writes.lockOwnEntryForUpdate(tx, entryId, now);
            const replayed =
              clientRequestId === undefined ? null : await this.copyUnderKey(tx, entryId, clientRequestId);
            const copy = replayed ?? (await addCopy(tx, { ...entry, id: entryId }, description, now, clientRequestId));

            return { entryId, result: toCollectionCopyDto(copy) };
          },
          resolveActingUserIdOrNull(this.abilityService),
          now,
        ),
      clientRequestId,
      COPY_KEY_SPELLINGS,
    );
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
   * so a sync leaves the copy as the user left it, and first keeps what the
   * copy said before as a revision, which can be restored. On a removed entry,
   * a corrected removal reason of a copy removed with the entry becomes the
   * entry's own reason, through the write runner's reconcile, whichever of
   * those copies it is. A taken-back copy never existed, so it takes no edit,
   * and answers `COLLECTION_COPY_NOT_FOUND` until the take-back is undone.
   */
  async update(entryId: string, copyId: string, dto: UpdateCollectionCopyDto): Promise<CollectionCopyDto> {
    if (Object.keys(pickDefined(dto)).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const { removedOn, removeReason, ...described } = dto;
    const now = new Date();
    const newRemoval = sentDate(removedOn, now, 'removedOn');

    return this.writes.run(
      async (tx) => {
        const entry = await this.writes.lockOwnEntryForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId, retractedAt: null },
          select: COPY_REVISION_SELECT,
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

        await recordCopyRevision(tx, copy);
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
   * (`copyRemovalData`), and a sync leaves the removed copy as it is; it
   * first keeps what the copy said before as a revision, so restoring that
   * makes the copy owned again (#1231).
   */
  async remove(
    entryId: string,
    copyId: string,
    { reason, removedOn }: RemoveCollectionCopyQueryDto,
  ): Promise<CollectionCopyDto> {
    const now = new Date();
    const given = sentDate(removedOn, now, 'removedOn');

    return this.writes.run(
      async (tx) => {
        const entry = await this.writes.lockOwnEntryForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId, AND: OWNED_COPY },
          select: COPY_REVISION_SELECT,
        });

        if (copy === null) {
          throw copyNotFound(copyId);
        }

        await this.assertMayRemoveIfLastOwned(tx, entryId, entry);

        const removal = removalOf(copy, given, now);
        assertRemovableOn(copy, removal);

        await recordCopyRevision(tx, copy);
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
   * The revisions of one copy of the acting user's own entry, newest
   * first, each in the shape you read the copy (#1231). Like the copy's
   * details, its history is yours alone, whatever the entry's reach, so the
   * entry is read as your own (`readOwnEntry`). A taken-back copy's history
   * stays readable, as the copy itself stays in the copies list: it is a
   * read, and shows you what undoing the take-back brings back.
   *
   * Each revision names its edition by id; it is read as it is now, and one
   * deleted since reads as none, as restoring the revision would give the
   * copy. A stored revision that can't be read back is left out, as it can't
   * be restored either, and the server's log says why.
   */
  async listRevisions(entryId: string, copyId: string): Promise<CollectionCopyRevisionDto[]> {
    const entry = await readOwnEntry(this.db, this.abilityService, entryId, {
      copies: { where: { id: copyId }, select: { revisions: REVISION_LIST_READ } },
    });
    const [copy] = entry.copies;

    if (copy === undefined) {
      throw copyNotFound(copyId);
    }

    const readable = readableRevisions(
      copyRevisionValuesSchema,
      copy.revisions,
      this.logger,
      (revisionId) => `Revision ${revisionId} of copy ${copyId}`,
    );
    const releases = await this.releaseSummaries(readable.map(({ values }) => values.releaseId));

    return readable.map(({ revision, values }) =>
      toCollectionCopyRevisionDto(
        revision,
        values,
        values.releaseId === null ? null : (releases.get(values.releaseId) ?? null),
      ),
    );
  }

  /**
   * Writes a revision's values back to its copy (#1231), as a correction of
   * the copy: what it says now is first kept as a revision of its own, and
   * the copy is stamped as edited by the user, so a sync leaves it as the
   * user left it. A revision the copy doesn't hold, or one whose stored
   * values can't be read back, answers `COLLECTION_REVISION_NOT_FOUND`. A
   * taken-back copy never existed, so it takes no restore, and answers
   * `COLLECTION_COPY_NOT_FOUND` until the take-back is undone.
   *
   * The restored values are held to what an edit is: a condition on a
   * digital copy, a price in a currency ISO 4217 doesn't list, an
   * acquisition or removal on a day that is today nowhere yet, and a removal
   * before the acquisition are refused. A digital entry's copies never take
   * a condition, and an entry's medium never changes, so stored values can't
   * name one; the check stays, so a damaged revision is refused rather than
   * written. An edition deleted since, or no longer one of the entry's
   * platform game, is restored as none rather than failing the write
   * (`restorableRelease`).
   *
   * A restore that makes a removed copy owned again needs room for it, as an
   * add does: on an entry whose user owns `COLLECTION_COPY_LIMIT` copies
   * already, it is refused with `COLLECTION_COPY_LIMIT_REACHED`. Otherwise a
   * removal, an add and a restore, repeated, would own copies past the cap.
   *
   * Through the write runner, a restore that makes a removed copy owned again
   * acquires a removed entry again and resumes its offers (#1221). One that
   * removes the entry's last owned copy removes the entry, with the restored
   * reason, so it is held to the entry's `delete` permission too, as the
   * copy removal is (#1288). One that leaves a copy removed with the entry
   * removed gives the entry the restored reason, as a corrected reason does
   * (#1231).
   *
   * A restored removal takes the revision's date and reason. When it is
   * recorded is the copy's own: now, for a copy the restore removes, and
   * unchanged, for one that stays removed (#1231). The revision this restore
   * keeps still holds the earlier stamp.
   */
  async restore(entryId: string, copyId: string, revisionId: string): Promise<CollectionCopyDto> {
    const now = new Date();

    return this.writes.run(
      async (tx) => {
        const entry = await this.writes.lockOwnEntryForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId, retractedAt: null },
          select: COPY_REVISION_SELECT,
        });

        if (copy === null) {
          throw copyNotFound(copyId);
        }

        const values = await this.revisionValues(tx, copyId, revisionId);
        const { description, removal } = restoredCopyOf(values);
        const columns = await copyColumns(tx, description, entry, now);

        assertNotInFuture(removal.removedOn, now, 'removedOn');
        assertRemovalAfterAcquisition(
          partialDateFromColumns(columns.acquiredOn ?? null, columns.acquiredOnPrecision ?? null),
          removal.removedOn,
        );

        const releaseId =
          values.releaseId === null ? null : await restorableRelease(tx, values.releaseId, entry.platformGameId);
        const removesEntry =
          copy.removedAt === null &&
          removal.removedAt !== null &&
          (await this.assertMayRemoveIfLastOwned(tx, entryId, entry));

        if (copy.removedAt !== null && removal.removedAt === null) {
          await assertCopyRoom(tx, entryId);
        }

        await recordCopyRevision(tx, copy);
        const restored = await tx.collectionCopy.update({
          where: { id: copyId },
          data: {
            ...columns,
            releaseId,
            // A copy the restore removes records the removal as written now,
            // and one that stays removed keeps its own stamp: the copy that
            // removed the entry is the one removed at its `deletedAt`, which
            // the write runner reads the entry's reason from (#1231).
            removedAt: removal.removedAt === null ? null : (copy.removedAt ?? now),
            removedOn: removal.removedOn?.on ?? null,
            removedOnPrecision: removal.removedOn?.precision ?? null,
            removeReason: removal.removeReason,
            editedByUserAt: now,
          },
          select: OWNER_COPY_SELECT,
        });

        return {
          entryId,
          result: toCollectionCopyDto(restored),
          // The entry's removal is this restore's, so it takes the restored
          // reason, not one read back from another copy; and a copy removed
          // with the entry that stays removed hands the entry its restored
          // reason, as a corrected reason does (#1231).
          ...(removesEntry || (removal.removedAt !== null && removedWithEntry(copy, entry))
            ? { removeReason: removal.removeReason }
            : {}),
        };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
    );
  }

  /**
   * Takes a copy back (#1231): the user says they never had it. It counts as
   * neither owned nor removed from now on, so it leaves the entry's quantity
   * and its rows, and only the copies list shows it, with its `retractedAt`.
   * A copy missing answers `COLLECTION_COPY_NOT_FOUND`.
   *
   * A copy that never existed can't remove the game, so taking back the
   * entry's last owned copy is refused with `COLLECTION_LAST_COPY`: the user
   * adds the right copy first, or removes the game. The owned copies are
   * counted under the entry's lock, which every copy write takes first, so two
   * take-backs can't each leave the other the last. A removed copy isn't
   * owned, so taking it back is always allowed, and changes no ownership; on
   * a removed entry the write runner reads the entry's reason again, from the
   * copies still removed. Taking back a removed entry's only removed copy so
   * leaves the entry removed with no reason, and undoing the take-back gives
   * the reason back.
   *
   * It is the user's word on the copy, so it stamps `editedByUserAt`: a sync
   * never brings the copy back. It keeps no revision: it changes none of the
   * values a revision holds, so restoring one would change nothing.
   *
   * Taking back a copy taken back already answers it as it stands, and
   * writes nothing to it (ADR 0002), before the last copy is counted: a
   * retry of a take-back that left the entry one owned copy answers the
   * copy, not a refusal.
   */
  async takeBack(entryId: string, copyId: string): Promise<CollectionCopyDto> {
    return this.setTakenBack(entryId, copyId, true);
  }

  /**
   * Undoes a copy's take-back (#1231): the copy counts again, as owned or as
   * removed, whichever it was. A copy missing answers
   * `COLLECTION_COPY_NOT_FOUND`; one that isn't taken back is answered as it
   * stands, and nothing is written to it (ADR 0002).
   *
   * A copy owned again needs room for it, as an add does: on an entry whose
   * user owns `COLLECTION_COPY_LIMIT` copies already, the undo is refused
   * with `COLLECTION_COPY_LIMIT_REACHED`. Otherwise a take-back, an add and
   * an undo, repeated, would own copies past the cap. A removed copy counts
   * as removed again, and needs no room.
   *
   * A copy owned again on a removed entry acquires the entry again, and the
   * write runner resumes the offers its removal paused (#1221). A removed
   * copy changes no ownership. Neither removes the entry, so neither needs
   * the entry's `delete` permission.
   *
   * Like the take-back, it stamps `editedByUserAt` and keeps no revision.
   */
  async undoTakeBack(entryId: string, copyId: string): Promise<CollectionCopyDto> {
    return this.setTakenBack(entryId, copyId, false);
  }

  /**
   * Takes the copy back (`takenBack` true) or undoes that, under the entry's
   * lock (#1231). A copy already as asked is answered as it stands, with no
   * write to it; its entry's ownership doesn't flip, so nothing is emitted
   * (ADR 0002).
   */
  private async setTakenBack(entryId: string, copyId: string, takenBack: boolean): Promise<CollectionCopyDto> {
    const now = new Date();

    return this.writes.run(
      async (tx) => {
        await this.writes.lockOwnEntryForUpdate(tx, entryId, now);
        const copy = await tx.collectionCopy.findUnique({
          where: { id: copyId, entryId },
          select: OWNER_COPY_SELECT,
        });

        if (copy === null) {
          throw copyNotFound(copyId);
        }

        if (isAlreadyTakenBackAs(copy, takenBack)) {
          return { entryId, result: toCollectionCopyDto(copy) };
        }

        // Neither taken back nor removed, the copy is owned.
        if (takenBack && copy.removedAt === null && (await this.isLastOwned(tx, entryId))) {
          throw lastCopyTakeBack();
        }

        if (!takenBack && copy.removedAt === null) {
          await assertCopyRoom(tx, entryId);
        }

        const written = await tx.collectionCopy.update({
          where: { id: copyId },
          data: takeBackData(takenBack, now),
          select: OWNER_COPY_SELECT,
        });

        return { entryId, result: toCollectionCopyDto(written) };
      },
      resolveActingUserIdOrNull(this.abilityService),
      now,
    );
  }

  /**
   * Whether an owned copy of the entry is its last owned one (#1231). Run it
   * under the entry's lock, with the copy still owned.
   */
  private async isLastOwned(tx: Prisma.TransactionClient, entryId: string): Promise<boolean> {
    return (await tx.collectionCopy.count({ where: { entryId, ...OWNED_COPY } })) === 1;
  }

  /**
   * Holds a write that removes an owned copy of a live entry to the entry's
   * `delete` permission when that copy is the entry's last owned one, as its
   * removal removes the entry (#1288). Answers whether it is the last. Run it
   * under the entry's lock, with the copy still owned.
   */
  private async assertMayRemoveIfLastOwned(
    tx: Prisma.TransactionClient,
    entryId: string,
    entry: LockedEntry,
  ): Promise<boolean> {
    if (!(await this.isLastOwned(tx, entryId))) {
      return false;
    }

    this.abilityService.assertCurrentActorCan(Action.delete, ResourceType.GameCollection, { id: entryId, ...entry });

    return true;
  }

  /**
   * The values of the copy's revision `revisionId`, read back through their
   * schema (#1231). A revision of another copy, none, or one whose values
   * fail the schema answers `COLLECTION_REVISION_NOT_FOUND`.
   */
  private async revisionValues(
    tx: Prisma.TransactionClient,
    copyId: string,
    revisionId: string,
  ): Promise<CopyRevisionValues> {
    return restorableValues(
      copyRevisionValuesSchema,
      await tx.collectionCopyRevision.findUnique({ where: { id: revisionId, copyId }, select: { values: true } }),
      revisionId,
      this.logger,
      `Revision ${revisionId} of copy ${copyId}`,
    );
  }

  /** The editions `releaseIds` name, by id, as they are now; one deleted since is absent (#1231). */
  private async releaseSummaries(
    releaseIds: readonly (string | null)[],
  ): Promise<Map<string, CollectionReleaseSummaryDto>> {
    const ids = [...new Set(releaseIds.filter((id): id is string => id !== null))];

    if (ids.length === 0) {
      return new Map();
    }

    const releases = await this.db.gameRelease.findMany({
      where: { id: { in: ids } },
      select: { id: true, editionName: true, releaseYear: true },
    });

    return new Map(releases.map((release) => [release.id, release]));
  }
}
