import type { Prisma } from '@bge/database';
import { Action, DatabaseService, ResourceType } from '@bge/database';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { Injectable } from '@nestjs/common';
import type { CollectionRatingChangeDto } from './dto';
import { toCollectionRatingChangeDto } from './dto';
import { collectionEntryNotFound } from './game-collection.errors';
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
 * The history of an entry's rating, on its owner's route (#1231). Each change
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
   * was recorded, and the id breaks the last tie. The history is the owner's
   * alone, whatever the entry's reach, so the entry is read as the actor's
   * own, under their read conditions: anyone else, and an actor that is no
   * user, gets `COLLECTION_ENTRY_NOT_FOUND`.
   */
  async list(entryId: string): Promise<CollectionRatingChangeDto[]> {
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
      select: {
        ratingChanges: {
          select: RATING_CHANGE_SELECT,
          orderBy: [{ occurredOn: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (entry === null) {
      throw collectionEntryNotFound(entryId);
    }

    return entry.ratingChanges.map(toCollectionRatingChangeDto);
  }
}
