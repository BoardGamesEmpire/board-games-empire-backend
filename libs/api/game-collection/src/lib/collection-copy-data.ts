import type { Prisma } from '@bge/database';
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
 * The columns of a new copy, from what the user said about it (#1231). A
 * field left out, or sent as null, is unknown. Refuses:
 *
 * - a release that doesn't exist, or that belongs to another platform game;
 * - a condition on a digital copy (`COLLECTION_CONDITION_DIGITAL`);
 * - an acquisition after today, in UTC (`COLLECTION_DATE_IN_FUTURE`);
 * - a price in a currency ISO 4217 doesn't list (`COLLECTION_CURRENCY_UNKNOWN`).
 *
 * The acquisition date has already passed the DTO's `@IsPartialDate()`, so it
 * parses. The release is read through `tx`, in the write's transaction.
 */
export async function copyCreateData(
  tx: Prisma.TransactionClient,
  dto: CreateCollectionCopyDto,
  entry: CopyEntry,
  now: Date,
): Promise<Prisma.CollectionCopyUncheckedCreateWithoutEntryInput> {
  const releaseId = dto.releaseId ?? null;
  const condition = dto.condition ?? null;
  const acquired = dto.acquiredOn == null ? null : parsePartialDate(dto.acquiredOn);
  const pricePaid = moneyOf(dto.pricePaid);
  const currentValue = moneyOf(dto.currentValue);

  if (condition !== null && entry.medium === GameMedium.Digital) {
    throw conditionOnDigital();
  }

  if (acquired !== null) {
    assertNotInFuture(acquired, now);
  }

  if (releaseId !== null) {
    await assertReleaseBelongsTo(tx, releaseId, entry.platformGameId);
  }

  return {
    releaseId,
    condition,
    acquiredOn: acquired?.on ?? null,
    acquiredOnPrecision: acquired?.precision ?? null,
    acquiredFrom: dto.acquiredFrom ?? null,
    pricePaidAmount: pricePaid?.amount ?? null,
    pricePaidCurrency: pricePaid?.currency ?? null,
    currentValueAmount: currentValue?.amount ?? null,
    currentValueCurrency: currentValue?.currency ?? null,
    note: dto.note ?? null,
  };
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
