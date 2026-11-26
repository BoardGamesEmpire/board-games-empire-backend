import type { Prisma } from '@bge/database';
import { constraintIdentity, DatabaseService, identifiesConstraint, normalizeClientRequestId } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { pickDefined } from '@bge/shared';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { RatingRevisionValues } from './collection-revisions';
import {
  parseRevisionValues,
  RATING_REVISION_SELECT,
  ratingRevisionValuesSchema,
  recordRatingRevision,
  restoredRatingOf,
} from './collection-revisions';
import { readOwnEntry } from './collection-row';
import { CollectionWriteService } from './collection-write.service';
import type {
  CollectionRatingChangeDto,
  CollectionRatingRevisionDto,
  CreateCollectionRatingChangeDto,
  UpdateCollectionRatingChangeDto,
} from './dto';
import { toCollectionRatingChangeDto, toCollectionRatingRevisionDto } from './dto';
import { ratingChangeNotFound, ratingChangeNotTakenBack, revisionNotFound } from './game-collection.errors';
import type { PartialDate } from './values/partial-date';
import { assertNotInFuture, parsePartialDate, todayUtc } from './values/partial-date';

/** What the rating history reads of each change (#1231). */
export const RATING_CHANGE_SELECT = {
  createdAt: true,
  id: true,
  occurredOn: true,
  occurredOnPrecision: true,
  rating: true,
  retractedAt: true,
} as const satisfies Prisma.CollectionRatingChangeSelect;

/**
 * Appends a change of the entry's rating, dated today in UTC (#1231). `rating`
 * is the rating from then on, null when the user cleared it. The caller holds
 * the entry's lock and has compared `rating` with the entry's current one, so
 * a write that changed nothing appends nothing.
 */
export async function appendRatingChange(
  tx: Prisma.TransactionClient,
  entryId: string,
  rating: number | null,
  now: Date,
): Promise<void> {
  const today = todayUtc(now);

  await tx.collectionRatingChange.create({
    data: { entryId, occurredOn: today.on, occurredOnPrecision: today.precision, rating },
    select: { id: true },
  });
}

/**
 * Appends a change of the entry's rating when a write sends one that differs
 * from `current`, the rating the locked row holds (#1231): `sent` undefined
 * is no rating sent, and null clears it. A new entry's `current` is null, so
 * its first rating appends one and a null appends none. A write that repeats
 * the rating appends nothing, so a replayed add or PATCH leaves the history
 * as it was.
 */
export async function appendRatingChangeIfChanged(
  tx: Prisma.TransactionClient,
  entryId: string,
  sent: number | null | undefined,
  current: number | null,
  now: Date,
): Promise<void> {
  if (sent !== undefined && sent !== current) {
    await appendRatingChange(tx, entryId, sent, now);
  }
}

/**
 * The unique that keeps one rating change per client request id on an entry,
 * in every spelling a P2002 identity reports it (see `identifiesConstraint`):
 * the index name, the raw columns, and the Prisma fields (#1231, #252).
 */
const CHANGE_KEY_SPELLINGS = [
  ['collection_rating_change_entry_client_request_id_unique'],
  ['entry_id', 'client_request_id'],
  ['entryId', 'clientRequestId'],
] as const;

/**
 * Whether `error` is a unique violation on a rating change's client request
 * id: a repeat of the add that committed first (#252). One whose constraint
 * can't be named counts, when the add was keyed: a change's only other unique
 * is its upstream account's key, which no add on this route sets.
 */
function isChangeKeyViolation(error: unknown): boolean {
  const identity = constraintIdentity(error);

  return identity.source === 'unknown' || identifiesConstraint(identity, ...CHANGE_KEY_SPELLINGS);
}

/** The order the history reads in: the changes with no known date, then by date, then by when each was recorded (#1231). */
const HISTORY_ORDER: Prisma.CollectionRatingChangeOrderByWithRelationInput[] = [
  { occurredOn: { sort: 'asc', nulls: 'first' } },
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** A change's revisions, newest first, then by id, so revisions kept in the same instant keep one order (#1231). */
const REVISION_ORDER: Prisma.CollectionRatingRevisionOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/**
 * A date a request sent, which the DTO's `@IsPartialDate()` has already
 * passed, refused when it is today nowhere yet (#1231).
 */
function sentDate(text: string, now: Date): PartialDate {
  const date = parsePartialDate(text);

  if (date === null) {
    throw new BadRequestException(t('validation.isPartialDate', { property: 'occurredOn' }));
  }

  assertNotInFuture(date, now, 'occurredOn');

  return date;
}

/**
 * The history of an entry's rating, on the entry owner's routes: the entry's
 * owner alone reads it and corrects it (#1231). Each change of the rating the
 * entry's own routes make is appended by {@link appendRatingChange}, under the
 * entry's lock.
 *
 * The owner can add an earlier change, edit one, take one back and undo
 * that, and restore a revision, on the terms copies have. Correcting the
 * history never changes the entry's current rating, and never reaches the
 * supply sync: a correction writes only rating change rows, and stamps the
 * entry's `lastUpdated`. Each write locks the entry's row first and holds the
 * entry to the actor's `update` conditions (`CollectionWriteService.lockOwnEntryForUpdate`); the
 * entry must be the acting user's own, so a change of another user's entry
 * answers `COLLECTION_ENTRY_NOT_FOUND`, and a change of another entry, as one
 * that doesn't exist, answers `COLLECTION_RATING_NOT_FOUND`.
 *
 * Every correction stamps `editedByUserAt`, so an upstream sync leaves the
 * change as the user left it (`SYNC_MAY_WRITE_RATING_CHANGE`). A change taken
 * back never happened, so it takes only the undo of its take-back: an edit
 * or a restore answers `COLLECTION_RATING_NOT_FOUND` until it is undone.
 */
@Injectable()
export class CollectionRatingService {
  private readonly logger = new Logger(CollectionRatingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly writes: CollectionWriteService,
  ) {}

  /**
   * Every change of the acting user's own entry's rating, oldest first
   * (#1231): the changes with no known date, then by date, then by when each
   * was recorded, and the id breaks the last tie. A change taken back is
   * listed, with its `retractedAt`, so its owner can undo the take-back. The
   * history is yours alone, whatever the entry's reach, so the entry is read
   * as your own (`readOwnEntry`).
   */
  async list(entryId: string): Promise<CollectionRatingChangeDto[]> {
    const entry = await readOwnEntry(this.db, this.abilityService, entryId, {
      ratingChanges: { select: RATING_CHANGE_SELECT, orderBy: HISTORY_ORDER },
    });

    return entry.ratingChanges.map(toCollectionRatingChangeDto);
  }

  /**
   * Adds an earlier change of the rating, `dto.rating` from `dto.occurredOn`
   * on (#1231). The date is refused when it is today nowhere yet
   * (`COLLECTION_DATE_IN_FUTURE`). The entry's current rating stays as it is.
   *
   * Keyed by `clientRequestId` (ADR 0002, #252): a repeat under a key the
   * entry already holds answers the change that key made, as it stands now,
   * taken back or corrected since included, whatever the repeat's body says,
   * and adds nothing. The key is looked up under the entry's lock and after
   * the checks that it is your entry and that you may update it, so a key is
   * no way past them.
   *
   * Two repeats wait for the entry's lock in turn, and the second finds the
   * first's change. Should a repeat still trip the key's unique, the add runs
   * once more, in a transaction of its own, and finds the change the other
   * committed: Postgres aborts the transaction the violation happened in, so
   * nothing inside it can look again.
   */
  async add(entryId: string, dto: CreateCollectionRatingChangeDto): Promise<CollectionRatingChangeDto> {
    const clientRequestId = normalizeClientRequestId(dto.clientRequestId);
    const now = new Date();

    const attempt = () =>
      this.write(entryId, now, async (tx) => {
        const replayed =
          clientRequestId === undefined
            ? null
            : await tx.collectionRatingChange.findUnique({
                where: { entryId_clientRequestId: { entryId, clientRequestId } },
                select: RATING_CHANGE_SELECT,
              });

        if (replayed !== null) {
          return toCollectionRatingChangeDto(replayed);
        }

        const occurred = sentDate(dto.occurredOn, now);
        const added = await tx.collectionRatingChange.create({
          data: {
            clientRequestId,
            editedByUserAt: now,
            entryId,
            occurredOn: occurred.on,
            occurredOnPrecision: occurred.precision,
            rating: dto.rating,
          },
          select: RATING_CHANGE_SELECT,
        });

        return toCollectionRatingChangeDto(added);
      });

    try {
      return await attempt();
    } catch (error) {
      if (clientRequestId === undefined || !isChangeKeyViolation(error)) {
        throw error;
      }

      return attempt();
    }
  }

  /**
   * Corrects one change of the entry's rating (#1231): the fields `dto`
   * names. First keeps what the change said before as a revision, which can
   * be restored. `null` for `rating` makes the change a clearing, and for
   * `occurredOn` makes its date unknown. A change taken back answers
   * `COLLECTION_RATING_NOT_FOUND`.
   */
  async update(
    entryId: string,
    ratingId: string,
    dto: UpdateCollectionRatingChangeDto,
  ): Promise<CollectionRatingChangeDto> {
    if (Object.keys(pickDefined(dto)).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const now = new Date();
    const occurred = dto.occurredOn === undefined || dto.occurredOn === null ? null : sentDate(dto.occurredOn, now);

    return this.write(entryId, now, async (tx) => {
      const change = await this.findLive(tx, entryId, ratingId);

      await recordRatingRevision(tx, change);

      return this.writeChange(tx, ratingId, {
        ...(dto.rating === undefined ? {} : { rating: dto.rating }),
        ...(dto.occurredOn === undefined
          ? {}
          : { occurredOn: occurred?.on ?? null, occurredOnPrecision: occurred?.precision ?? null }),
        editedByUserAt: now,
      });
    });
  }

  /**
   * Takes a change back (#1231): the user says it never happened. It stays in
   * the history, flagged by `retractedAt`, and the entry's current rating
   * stays as it is, the latest change included. A change missing, or taken
   * back already, answers `COLLECTION_RATING_NOT_FOUND`.
   *
   * It changes none of the values a revision holds, so it keeps none; it
   * stamps `editedByUserAt`, so a sync never brings the change back.
   */
  async takeBack(entryId: string, ratingId: string): Promise<CollectionRatingChangeDto> {
    const now = new Date();

    return this.write(entryId, now, async (tx) => {
      await this.findLive(tx, entryId, ratingId);

      return this.writeChange(tx, ratingId, { editedByUserAt: now, retractedAt: now });
    });
  }

  /**
   * Undoes a change's take-back (#1231). A change that exists but isn't taken
   * back answers 409 `COLLECTION_RATING_NOT_TAKEN_BACK`, never the row's 404,
   * which a client reads as "this row is gone"; one missing, or of another
   * entry, answers `COLLECTION_RATING_NOT_FOUND`. Like the take-back, it keeps
   * no revision, and stamps `editedByUserAt`.
   */
  async undoTakeBack(entryId: string, ratingId: string): Promise<CollectionRatingChangeDto> {
    const now = new Date();

    return this.write(entryId, now, async (tx) => {
      const change = await tx.collectionRatingChange.findUnique({
        where: { id: ratingId, entryId },
        select: { id: true, retractedAt: true },
      });

      if (change === null) {
        throw ratingChangeNotFound(ratingId);
      }

      if (change.retractedAt === null) {
        throw ratingChangeNotTakenBack();
      }

      return this.writeChange(tx, ratingId, { editedByUserAt: now, retractedAt: null });
    });
  }

  /**
   * The revisions of one change of the acting user's own entry's rating,
   * newest first, each in the shape its owner reads the change (#1231). Like
   * the history itself they are yours alone, so the entry is read as your own
   * (`readOwnEntry`). A taken-back change's revisions stay readable. A stored
   * revision that can't be read back is left out, as it can't be restored
   * either, and the server's log says why.
   */
  async listRevisions(entryId: string, ratingId: string): Promise<CollectionRatingRevisionDto[]> {
    const entry = await readOwnEntry(this.db, this.abilityService, entryId, {
      ratingChanges: {
        where: { id: ratingId },
        select: { revisions: { select: { createdAt: true, id: true, values: true }, orderBy: REVISION_ORDER } },
      },
    });
    const [change] = entry.ratingChanges;

    if (change === undefined) {
      throw ratingChangeNotFound(ratingId);
    }

    return change.revisions.flatMap((revision) => {
      const values = this.readValues(ratingId, revision.id, revision.values);

      return values === null ? [] : [toCollectionRatingRevisionDto(revision, values)];
    });
  }

  /**
   * Writes a revision's rating and date back to its change (#1231), as a
   * correction: what the change says now is first kept as a revision of its
   * own, so a restore can be undone the same way, and the change is stamped
   * as edited by the user. A revision the change doesn't hold, or one whose
   * stored values can't be read back, answers `COLLECTION_REVISION_NOT_FOUND`;
   * a change taken back, `COLLECTION_RATING_NOT_FOUND`. The restored date is
   * held to what an edit is: one that is today nowhere yet is refused.
   */
  async restore(entryId: string, ratingId: string, revisionId: string): Promise<CollectionRatingChangeDto> {
    const now = new Date();

    return this.write(entryId, now, async (tx) => {
      const change = await this.findLive(tx, entryId, ratingId);
      const values = await this.revisionValues(tx, ratingId, revisionId);
      const { occurredOn, rating } = restoredRatingOf(values);

      if (occurredOn !== null) {
        assertNotInFuture(occurredOn, now, 'occurredOn');
      }

      await recordRatingRevision(tx, change);

      return this.writeChange(tx, ratingId, {
        editedByUserAt: now,
        occurredOn: occurredOn?.on ?? null,
        occurredOnPrecision: occurredOn?.precision ?? null,
        rating,
      });
    });
  }

  /**
   * Runs `write` in one transaction that begins by locking the entry and
   * checking it is the actor's own, under their `update` conditions
   * (`CollectionWriteService.lockOwnEntryForUpdate`). It doesn't reconcile the entry's ownership or
   * run the supply sync: no rating change write changes what the entry
   * supplies.
   */
  private async write<T>(entryId: string, now: Date, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await this.writes.lockOwnEntryForUpdate(tx, this.abilityService, entryId, now);

      return write(tx);
    });
  }

  /** The entry's rating change `ratingId`, as a revision is written from it, unless it is taken back (#1231). */
  private async findLive(tx: Prisma.TransactionClient, entryId: string, ratingId: string) {
    const change = await tx.collectionRatingChange.findUnique({
      where: { id: ratingId, entryId, retractedAt: null },
      select: RATING_REVISION_SELECT,
    });

    if (change === null) {
      throw ratingChangeNotFound(ratingId);
    }

    return change;
  }

  private async writeChange(
    tx: Prisma.TransactionClient,
    ratingId: string,
    data: Prisma.CollectionRatingChangeUncheckedUpdateInput,
  ): Promise<CollectionRatingChangeDto> {
    const written = await tx.collectionRatingChange.update({
      where: { id: ratingId },
      data,
      select: RATING_CHANGE_SELECT,
    });

    return toCollectionRatingChangeDto(written);
  }

  /**
   * The values of the change's revision `revisionId`, read back through their
   * schema (#1231). A revision of another change, none, or one whose values
   * fail the schema answers `COLLECTION_REVISION_NOT_FOUND`.
   */
  private async revisionValues(
    tx: Prisma.TransactionClient,
    ratingId: string,
    revisionId: string,
  ): Promise<RatingRevisionValues> {
    const revision = await tx.collectionRatingRevision.findUnique({
      where: { id: revisionId, ratingChangeId: ratingId },
      select: { values: true },
    });
    const values = revision === null ? null : this.readValues(ratingId, revisionId, revision.values);

    if (values === null) {
      throw revisionNotFound(revisionId);
    }

    return values;
  }

  private readValues(ratingId: string, revisionId: string, stored: unknown): RatingRevisionValues | null {
    return parseRevisionValues(
      ratingRevisionValuesSchema,
      stored,
      this.logger,
      `Revision ${revisionId} of rating change ${ratingId}`,
    );
  }
}
