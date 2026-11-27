import type { CollectionCopy, DatePrecision, GameCondition, GameRemovalReason, Prisma } from '@bge/database';
import { foreignKeyIdentity, GameMedium, identifiesConstraint, isPrismaForeignKeyConstraintError } from '@bge/database';
import type { OwnerCopyRow } from './collection-row';
import { OWNED_COPY, OWNER_COPY_SELECT } from './collection-row';
import type { CollectionCopyDescriptionDto } from './dto/create-collection-copy.dto';
import {
  conditionOnDigital,
  copyLimitReached,
  releaseNotFound,
  releasePlatformMismatch,
} from './game-collection.errors';
import type { Money } from './values/money';
import { assertKnownCurrency } from './values/money';
import type { PartialDate } from './values/partial-date';
import {
  assertRemovalAfterAcquisition,
  defaultRemovalDate,
  partialDateFromColumns,
  sentDate,
} from './values/partial-date';

/**
 * The most copies one collection entry holds that the user still owns
 * (#1231). Removed and taken-back copies don't count: each removal and
 * acquisition again adds a copy, and no route deletes one, so counting them
 * would one day refuse the game for good.
 */
export const COLLECTION_COPY_LIMIT = 100;

/** What a copy belongs to: the entry's medium decides whether it has a condition, its platform game which releases it may be. */
interface CopyEntry {
  medium: GameMedium;
  platformGameId: string;
}

/**
 * What a user says about a copy, adding or editing it (#1231): each field of
 * {@link CollectionCopyDescriptionDto}, left out when not said, null when said
 * to be unknown.
 */
export type CopyDescription = {
  [K in keyof CollectionCopyDescriptionDto]?: CollectionCopyDescriptionDto[K] | null;
};

/** The columns of a copy that describe it, as {@link copyColumns} writes them (#1231). */
export interface CopyColumns {
  acquiredFrom: string | null;
  acquiredOn: Date | null;
  acquiredOnPrecision: DatePrecision | null;
  condition: GameCondition | null;
  currentValueAmount: number | null;
  currentValueCurrency: string | null;
  note: string | null;
  pricePaidAmount: number | null;
  pricePaidCurrency: string | null;
  releaseId: string | null;
}

/** A copy nothing is known about (#1231). */
const UNKNOWN_COPY: CopyColumns = {
  acquiredFrom: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  condition: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  releaseId: null,
};

/**
 * The columns of a new copy, from what the user said about it (#1231). A
 * field left out, or sent as null, is unknown. Refuses what
 * {@link copyColumns} refuses.
 */
export async function copyCreateData(
  tx: Prisma.TransactionClient,
  dto: CopyDescription,
  entry: CopyEntry,
  now: Date,
): Promise<Prisma.CollectionCopyUncheckedCreateWithoutEntryInput> {
  return { ...UNKNOWN_COPY, ...(await copyColumns(tx, dto, entry, now)) };
}

/**
 * The columns for what the user said about a copy, adding or editing it
 * (#1231): only the fields `dto` names, so an edit leaves the rest as they
 * are, and a field sent as null clears. Refuses:
 *
 * - a price in a currency ISO 4217 doesn't list (`COLLECTION_CURRENCY_UNKNOWN`);
 * - a condition on a digital copy (`COLLECTION_CONDITION_DIGITAL`);
 * - an acquisition on a day that is today nowhere yet (`COLLECTION_DATE_IN_FUTURE`);
 * - a release that doesn't exist (`GAME_RELEASE_NOT_FOUND`), or that belongs
 *   to another platform game (`COLLECTION_RELEASE_PLATFORM_MISMATCH`).
 *
 * The acquisition date has already passed the DTO's `@IsPartialDate()`, so it
 * parses. The release is read through `tx`, in the write's transaction.
 */
export async function copyColumns(
  tx: Prisma.TransactionClient,
  dto: CopyDescription,
  entry: CopyEntry,
  now: Date,
): Promise<Partial<CopyColumns>> {
  const columns: Partial<CopyColumns> = {};

  if (dto.pricePaid !== undefined) {
    const pricePaid = moneyOf(dto.pricePaid);
    columns.pricePaidAmount = pricePaid?.amount ?? null;
    columns.pricePaidCurrency = pricePaid?.currency ?? null;
  }

  if (dto.currentValue !== undefined) {
    const currentValue = moneyOf(dto.currentValue);
    columns.currentValueAmount = currentValue?.amount ?? null;
    columns.currentValueCurrency = currentValue?.currency ?? null;
  }

  if (dto.condition !== undefined) {
    if (dto.condition !== null && entry.medium === GameMedium.Digital) {
      throw conditionOnDigital();
    }

    columns.condition = dto.condition;
  }

  if (dto.acquiredOn !== undefined) {
    const acquired = sentDate(dto.acquiredOn, now, 'acquiredOn');
    columns.acquiredOn = acquired?.on ?? null;
    columns.acquiredOnPrecision = acquired?.precision ?? null;
  }

  if (dto.releaseId !== undefined) {
    if (dto.releaseId !== null) {
      await assertReleaseBelongsTo(tx, dto.releaseId, entry.platformGameId);
    }

    columns.releaseId = dto.releaseId;
  }

  if (dto.acquiredFrom !== undefined) {
    columns.acquiredFrom = dto.acquiredFrom;
  }

  if (dto.note !== undefined) {
    columns.note = dto.note;
  }

  return columns;
}

/**
 * Refuses one more owned copy on an entry whose user owns
 * {@link COLLECTION_COPY_LIMIT} of its copies already
 * (`COLLECTION_COPY_LIMIT_REACHED`, #1231): an added copy, or one a restore or
 * an undone take-back makes owned again. Run it under the entry's lock, so
 * two of them can't both pass it.
 */
export async function assertCopyRoom(tx: Prisma.TransactionClient, entryId: string): Promise<void> {
  const held = await tx.collectionCopy.count({ where: { entryId, ...OWNED_COPY } });

  if (held >= COLLECTION_COPY_LIMIT) {
    throw copyLimitReached(COLLECTION_COPY_LIMIT);
  }
}

/**
 * Adds one copy to an entry that exists, as the user described it (#1231):
 * the copy route's add, and the add that acquires a removed entry again.
 * Under the entry's lock, the room is checked first, then the description,
 * then the copy is written, keyed by `clientRequestId` when the route's
 * client sent one. Answers the copy in the entry owner's shape.
 *
 * A release read by {@link copyColumns} can still go before the insert; its
 * failure then answers `GAME_RELEASE_NOT_FOUND`, as a release never there
 * does ({@link writingRelease}).
 */
export async function addCopy(
  tx: Prisma.TransactionClient,
  entry: CopyEntry & { id: string },
  description: CopyDescription,
  now: Date,
  clientRequestId?: string,
): Promise<OwnerCopyRow> {
  await assertCopyRoom(tx, entry.id);
  const data = await copyCreateData(tx, description, entry, now);

  return writingRelease(description.releaseId, () =>
    tx.collectionCopy.create({
      data: { entryId: entry.id, ...data, ...(clientRequestId === undefined ? {} : { clientRequestId }) },
      select: OWNER_COPY_SELECT,
    }),
  );
}

/** What a removal is checked against: the copy's acquisition (#1231). */
type RemovalCheckSource = Pick<CollectionCopy, 'acquiredOn' | 'acquiredOnPrecision'>;

/**
 * The date `copy`'s removal records (#1231): the one the user gave, or, when
 * they gave none, today in UTC or the copy's later acquisition day
 * ({@link defaultRemovalDate}). Decided per copy, for one copy or each copy
 * of the entry.
 */
export function removalOf(copy: RemovalCheckSource, given: PartialDate | null, now: Date): PartialDate {
  return given ?? defaultRemovalDate(partialDateFromColumns(copy.acquiredOn, copy.acquiredOnPrecision), now);
}

/**
 * Refuses the removal of `copy` dated `removal` when it ends before the copy
 * was acquired (`COLLECTION_DATE_ORDER`, #1231): the check every removal of a
 * copy makes, one copy or the whole entry.
 */
export function assertRemovableOn(copy: RemovalCheckSource, removal: PartialDate): void {
  assertRemovalAfterAcquisition(partialDateFromColumns(copy.acquiredOn, copy.acquiredOnPrecision), removal);
}

/**
 * What a user's removal of a copy writes (#1231): when it was recorded, the
 * date it happened, at its precision, and its reason. A removal is the user's
 * word on the copy, so it stamps `editedByUserAt`, and a sync leaves the
 * removed copy as it is.
 */
export function copyRemovalData(
  removal: PartialDate,
  reason: GameRemovalReason | null | undefined,
  now: Date,
): Prisma.CollectionCopyUpdateManyMutationInput {
  return {
    removedAt: now,
    removedOn: removal.on,
    removedOnPrecision: removal.precision,
    removeReason: reason ?? null,
    editedByUserAt: now,
  };
}

/**
 * The rule that a copy's release exists and is a release of its entry's
 * platform game, in every spelling a P2003 identity reports it (see
 * `identifiesConstraint`): the trigger that checks both names itself, and the
 * release's foreign key by its name, its column and its Prisma field (#1231).
 */
const COPY_RELEASE_SPELLINGS = [
  ['collection_copies_release_match'],
  ['collection_copies_release_id_fkey'],
  ['release_id'],
  ['releaseId'],
] as const;

/** Whether `error` is a copy's release failing the rule above: gone since it was read (#1231). */
export function isCopyReleaseViolation(error: unknown): boolean {
  return identifiesConstraint(foreignKeyIdentity(error), ...COPY_RELEASE_SPELLINGS);
}

/**
 * Runs a copy write that may set `releaseId` (#1231). The release was read
 * first, without a lock, so it can go before the write; the write's foreign
 * key then fails, and answers `GAME_RELEASE_NOT_FOUND`, as a release never
 * there does, rather than a 500.
 *
 * A failure whose constraint can't be named counts when the write sets a
 * release: a copy written under its entry's lock has no other reference that
 * can go meanwhile, as the entry's row is held.
 */
export async function writingRelease<T>(releaseId: string | null | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      releaseId != null &&
      isPrismaForeignKeyConstraintError(error) &&
      (isCopyReleaseViolation(error) || foreignKeyIdentity(error).source === 'unknown')
    ) {
      throw releaseNotFound(releaseId);
    }

    throw error;
  }
}

/** A price as sent, its currency checked against ISO 4217; null when none was sent (#1231). */
function moneyOf(money: Money | null | undefined): Money | null {
  if (money == null) {
    return null;
  }

  assertKnownCurrency(money.currency);

  return { amount: money.amount, currency: money.currency };
}

/**
 * Refuses a release that doesn't exist (`GAME_RELEASE_NOT_FOUND`), or that is
 * a release of another platform game than the entry's
 * (`COLLECTION_RELEASE_PLATFORM_MISMATCH`, #1231).
 */
async function assertReleaseBelongsTo(
  tx: Prisma.TransactionClient,
  releaseId: string,
  platformGameId: string,
): Promise<void> {
  const release = await tx.gameRelease.findUnique({
    where: { id: releaseId },
    select: { platformGameId: true },
  });

  if (!release) {
    throw releaseNotFound(releaseId);
  }

  if (release.platformGameId !== platformGameId) {
    throw releasePlatformMismatch(releaseId, platformGameId);
  }
}
