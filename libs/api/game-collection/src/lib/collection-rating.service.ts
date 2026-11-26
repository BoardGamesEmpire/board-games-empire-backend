import type { Prisma } from '@bge/database';
import { DatabaseService } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { Injectable } from '@nestjs/common';
import { readOwnEntry } from './collection-row';
import type { CollectionRatingChangeDto } from './dto';
import { toCollectionRatingChangeDto } from './dto';
import { todayUtc } from './values/partial-date';

/** What the rating history reads of each change (#1231). */
export const RATING_CHANGE_SELECT = {
  createdAt: true,
  id: true,
  occurredOn: true,
  occurredOnPrecision: true,
  rating: true,
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
 * The history of an entry's rating, on the entry owner's route: the entry's owner
 * alone reads it (#1231). Each change
 * of the rating the entry's own routes make is appended by
 * {@link appendRatingChange}, under the entry's lock.
 */
@Injectable()
export class CollectionRatingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Every change of the acting user's own entry's rating, oldest first
   * (#1231): the changes with no known date, then by date, then by when each
   * was recorded, and the id breaks the last tie. The history is yours alone,
   * whatever the entry's reach, so the entry is read as your own
   * (`readOwnEntry`).
   */
  async list(entryId: string): Promise<CollectionRatingChangeDto[]> {
    const entry = await readOwnEntry(this.db, this.abilityService, entryId, {
      ratingChanges: {
        select: RATING_CHANGE_SELECT,
        orderBy: [{ occurredOn: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      },
    });

    return entry.ratingChanges.map(toCollectionRatingChangeDto);
  }
}
