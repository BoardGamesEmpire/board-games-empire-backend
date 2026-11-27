import type { ExpansionLink, Prisma } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import type { AbilityService } from '@bge/permissions';
import { resolveActingUserIdOrNull } from '@bge/permissions';
import type { CollectionCopyDto } from './dto/collection-copy.dto';
import { toCollectionCopyDto } from './dto/collection-copy.dto';
import { collectionEntryNotFound } from './game-collection.errors';

/**
 * The players and play time a game carries and its platform game may
 * override, selected the same way on both (#1070).
 */
const PLAYERS_AND_PLAY_TIME = {
  minPlayers: true,
  maxPlayers: true,
  minPlayTime: true,
  maxPlayTime: true,
} as const satisfies Prisma.GameSelect & Prisma.PlatformGameSelect;

/**
 * A copy the user still owns: neither removed nor taken back (#1231). An
 * entry's `quantity` counts these, and the entry is removed with its last.
 */
export const OWNED_COPY: Prisma.CollectionCopyWhereInput = { removedAt: null, retractedAt: null };

/**
 * A copy the user removed, and didn't take back (#1231): a taken-back copy
 * never happened, so it is no removal. An entry's removal reason is read from
 * these.
 */
export const REMOVED_COPY: Prisma.CollectionCopyWhereInput = { removedAt: { not: null }, retractedAt: null };

/**
 * A copy as the entry's owner reads it on the copy routes (#1231): every field that
 * describes it, its acquisition and its removal included, and its release's
 * name and year. When the user last edited it, and the upstream account that
 * synced it, are never selected, so they never ship.
 */
export const OWNER_COPY_SELECT = {
  id: true,
  createdAt: true,
  condition: true,
  acquiredOn: true,
  acquiredOnPrecision: true,
  acquiredFrom: true,
  pricePaidAmount: true,
  pricePaidCurrency: true,
  currentValueAmount: true,
  currentValueCurrency: true,
  note: true,
  removedAt: true,
  removedOn: true,
  removedOnPrecision: true,
  removeReason: true,
  release: { select: { id: true, editionName: true, releaseYear: true } },
} as const satisfies Prisma.CollectionCopySelect;

export type OwnerCopyRow = Prisma.CollectionCopyGetPayload<{ select: typeof OWNER_COPY_SELECT }>;

/**
 * A copy as every reader of its entry but the entry's owner sees it (#1231): its id,
 * its edition and its condition. What it cost, what it is worth, where and
 * when it was acquired, and its note are the entry owner's alone, whatever the
 * entry's reach, so they are not selected here and can't ship to anyone else.
 */
export const PUBLIC_COPY_SELECT = {
  condition: true,
  id: true,
  release: { select: { editionName: true, id: true, releaseYear: true } },
} as const satisfies Prisma.CollectionCopySelect;

export type PublicCopyRow = Prisma.CollectionCopyGetPayload<{ select: typeof PUBLIC_COPY_SELECT }>;

/** Oldest first, then by id, so copies made in the same instant keep one order (#1231). */
export const COPY_ORDER: Prisma.CollectionCopyOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }];

/**
 * The owned copies of `entryIds` in the entry owner's shape, by entry (#1231), for
 * the entries among them that `actingUserId` owns; any other entry is left
 * out, and its row keeps the public copies `COLLECTION_INCLUDE` read.
 *
 * - The `entry: { userId }` bound is what keeps the private fields to the
 *   entry's owner. A reader who may read the entry, staff included, is not
 *   the entry's owner, so the query finds none of its copies.
 * - It is a top-level query of its own, never a relation filter in an
 *   include, where Prisma can drop a filter (`docs/agents/gotchas.md`).
 * - Removed and taken-back copies are left out, as on every row: the copy
 *   routes list them.
 */
export async function readOwnerCopies(
  db: Pick<Prisma.TransactionClient, 'collectionCopy'>,
  entryIds: readonly string[],
  actingUserId: string,
): Promise<Map<string, CollectionCopyDto[]>> {
  const byEntry = new Map<string, CollectionCopyDto[]>();
  if (entryIds.length === 0) {
    return byEntry;
  }

  const copies = await db.collectionCopy.findMany({
    where: { entryId: { in: [...entryIds] }, entry: { userId: actingUserId }, ...OWNED_COPY },
    select: { ...OWNER_COPY_SELECT, entryId: true },
    orderBy: COPY_ORDER,
  });

  for (const { entryId, ...copy } of copies) {
    byEntry.set(entryId, [...(byEntry.get(entryId) ?? []), toCollectionCopyDto(copy)]);
  }

  return byEntry;
}

/**
 * The acting user's own entry, read with `select`, for the routes only the
 * entry's owner reads: its copies and its rating history (#1231). What they
 * send is yours alone, whatever the entry's reach, so the entry is read as
 * the actor's own, under their read conditions. An entry of anyone else's,
 * and any entry for an actor that is no user, answers
 * `COLLECTION_ENTRY_NOT_FOUND`, and an actor that is no user reads nothing.
 */
export async function readOwnEntry<S extends Prisma.GameCollectionSelect>(
  db: Pick<Prisma.TransactionClient, 'gameCollection'>,
  abilityService: AbilityService,
  entryId: string,
  select: S,
) {
  const userId = resolveActingUserIdOrNull(abilityService);

  if (userId === null) {
    throw collectionEntryNotFound(entryId);
  }

  const entry = await db.gameCollection.findUnique({
    where: {
      id: entryId,
      userId,
      // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
      AND: abilityService.getCurrentResourceConditions(ResourceType.GameCollection, Action.read),
    },
    select,
  });

  if (entry === null) {
    throw collectionEntryNotFound(entryId);
  }

  return entry;
}

/**
 * What a collection row embeds, so a client can render, filter, sort and nest
 * a collection without further fetches (#1070): the platform game with its
 * overrides of players and play time and of content type (#1391), its
 * platform's type, and the game's content type, year, players and play time.
 * Each field is named, so no column ships by default (#460). The count of
 * owned copies becomes the row's `quantity`, and each owned copy is read in
 * its public shape, which every reader may see (#1231). The entry owner's shape is
 * read apart, by `readOwnerCopies`.
 */
export const COLLECTION_INCLUDE = {
  _count: { select: { copies: { where: OWNED_COPY } } },
  copies: { where: OWNED_COPY, select: PUBLIC_COPY_SELECT, orderBy: COPY_ORDER },
  platformGame: {
    select: {
      id: true,
      image: true,
      thumbnail: true,
      contentType: true,
      ...PLAYERS_AND_PLAY_TIME,
      platform: { select: { id: true, name: true, slug: true, platformType: true } },
      game: {
        select: {
          id: true,
          title: true,
          subtitle: true,
          image: true,
          thumbnail: true,
          contentType: true,
          publishYear: true,
          ...PLAYERS_AND_PLAY_TIME,
        },
      },
    },
  },
} satisfies Prisma.GameCollectionInclude;

export type GameCollectionWithRelations = Prisma.GameCollectionGetPayload<{ include: typeof COLLECTION_INCLUDE }>;

/**
 * The entries changed since `since`, for the `updatedSince` catch-up drain
 * (#1070): the entry itself, or a value it embeds. Beside the entry's own
 * arm come the platform game, its platform, the game, the game's links as an
 * expansion, those links' base games, and those base games' platform games.
 * A relation added to `COLLECTION_INCLUDE` needs an arm here, or the drain
 * misses its changes.
 *
 * - Each owned copy's release has an arm: a re-import renames a release in
 *   place without touching the entry (#1231).
 * - The copies themselves, and their count, need no arm: every write of a
 *   copy runs through `CollectionWriteService`, whose `reconcileOwnership`
 *   sets the entry's `lastUpdated` and so bumps its `updatedAt`, and the
 *   entry's own arm resends the row (#1231).
 * - Each arm tests `updatedAt` alone, under no ceiling. A base game whose
 *   own `reach` or `deletedAt` changes takes a new `updatedAt`, so the row is
 *   resent whether the viewer gained or lost it.
 * - A row lists a base game only when the base game has a platform game on
 *   the row's platform (#1391), so a base game's new platform game resends
 *   the row. The arm can't name the row's platform, so a platform game on
 *   any platform resends it.
 * - A link deleted outright leaves nothing to test, so a client keeps the
 *   stale base game id until it reloads in full. Today a link goes with one
 *   of its games, and games are hard-deleted (#476). It also goes when a
 *   re-import moves its add-on off the add-on content types, but that import
 *   writes the add-on game's new content type, so the game's own arm resends
 *   the row (#1391). A path that unlinks games on their own, leaving both
 *   untouched, would meet the gap. A base game's platform game deleted
 *   outright is the same: nothing is left to test (#1391).
 * - A release deleted outright is the same gap for a copy's edition. Its
 *   foreign key sets the copy's `releaseId` to null in the database, which
 *   bumps neither the copy's nor the entry's `updatedAt`, so the drain does
 *   not resend the row, and a client keeps the deleted edition until it
 *   reloads in full (#1231).
 * - Whether the viewer could open a base game also turns on rows no arm
 *   reads: a friendship, a block, a share, a household membership. A change
 *   there resends nothing, so a client sees the base game appear or go only
 *   on a full reload.
 */
export function changedSince(since: Date): Prisma.GameCollectionWhereInput {
  const changed = { updatedAt: { gte: since } };

  return {
    OR: [
      changed,
      {
        platformGame: {
          is: {
            OR: [
              changed,
              { platform: { is: changed } },
              {
                game: {
                  is: {
                    OR: [
                      changed,
                      {
                        expansionEntries: {
                          some: {
                            OR: [
                              changed,
                              { baseGame: { is: changed } },
                              { baseGame: { is: { platformGames: { some: changed } } } },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      { copies: { some: { ...OWNED_COPY, release: { is: changed } } } },
    ],
  };
}

type IncludedPlatformGame = GameCollectionWithRelations['platformGame'];

/**
 * A collection row as the routes send it: the include's row, with its game's
 * `baseGames`, read after it by a link read of its own (#1070), its count of
 * owned copies as `quantity`, and its owned copies (#1231).
 */
export type GameCollectionRow = Omit<GameCollectionWithRelations, '_count' | 'copies' | 'platformGame'> & {
  /**
   * The copies the entry's owner still has, oldest first (#1231): in the owner's
   * shape on the rows `readOwnerCopies` finds them for, and in the public
   * shape on every other row.
   */
  copies: (CollectionCopyDto | PublicCopyRow)[];

  /**
   * Whether the entry's game is on the acting user's wishlist (#1241). Set on
   * the rows `GET /users/:userId/game-collections` serves only; `null` for an
   * actor with no wishlist they can read.
   */
  onWishlist?: boolean | null;

  platformGame: Omit<IncludedPlatformGame, 'game'> & {
    game: IncludedPlatformGame['game'] & { baseGames: ExpansionLink[] };
  };

  /** The number of copies the entry's owner still has: neither removed nor taken back (#1231). */
  quantity: number;
};

/**
 * Whether `copy` was removed with its entry (#1231): every write that removes
 * an entry stamps the copy's `removedAt` and the entry's `deletedAt` from one
 * instant.
 */
export function removedWithEntry(copy: { removedAt: Date | null }, entry: { deletedAt: Date | null }): boolean {
  return copy.removedAt !== null && entry.deletedAt !== null && copy.removedAt.getTime() === entry.deletedAt.getTime();
}
