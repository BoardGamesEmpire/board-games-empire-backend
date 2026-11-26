import type { DatePrecision, GameCondition, Prisma } from '@bge/database';
import { GameMedium } from '@bge/database';
import { t } from '@bge/i18n';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CreateCollectionCopyDto } from './dto/create-collection-copy.dto';
import { conditionOnDigital, copyLimitReached } from './game-collection.errors';
import type { Money } from './values/money';
import { assertKnownCurrency } from './values/money';
import { assertNotInFuture, parsePartialDate } from './values/partial-date';

/**
 * The most copies one collection entry holds, counting removed and
 * taken-back ones, so its history stays bounded too (#1231).
 */
export const COLLECTION_COPY_LIMIT = 100;

/** What a copy belongs to: the entry's medium decides whether it has a condition, its platform game which releases it may be. */
interface CopyEntry {
  medium: GameMedium;
  platformGameId: string;
}

/**
 * What a user says about a copy, adding or editing it (#1231): each field of
 * {@link CreateCollectionCopyDto}, left out when not said, null when said to
 * be unknown.
 */
export type CopyDescription = { [K in keyof CreateCollectionCopyDto]?: CreateCollectionCopyDto[K] | null };

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
 * - an acquisition after today, in UTC (`COLLECTION_DATE_IN_FUTURE`);
 * - a release that doesn't exist, or that belongs to another platform game.
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
    const acquired = dto.acquiredOn === null ? null : parsePartialDate(dto.acquiredOn);

    if (acquired !== null) {
      assertNotInFuture(acquired, now);
    }

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
 * Refuses one more copy on an entry that holds {@link COLLECTION_COPY_LIMIT}
 * already, in any state (`COLLECTION_COPY_LIMIT_REACHED`, #1231). Run it under
 * the entry's lock, so two acquisitions can't both pass it.
 */
export async function assertCopyRoom(tx: Prisma.TransactionClient, entryId: string): Promise<void> {
  const held = await tx.collectionCopy.count({ where: { entryId } });

  if (held >= COLLECTION_COPY_LIMIT) {
    throw copyLimitReached(COLLECTION_COPY_LIMIT);
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
 * Refuses a release that doesn't exist, or that is a release of another
 * platform game than the entry's, with the refusals the entry's own release
 * had before the release moved to its copies (#1231).
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
    throw new NotFoundException(t('errors.game_release.not_found', { id: releaseId }));
  }

  if (release.platformGameId !== platformGameId) {
    throw new BadRequestException(t('errors.game_collection.release_platform_mismatch', { releaseId, platformGameId }));
  }
}
