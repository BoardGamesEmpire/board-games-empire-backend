import { ContentType, GameMedium, PlatformType, Reach, type PrismaClient } from '@bge/database';
import { randomUUID } from 'node:crypto';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { tabletopPlatform } from '../support/seeded-platforms';

/**
 * An offered entry for `ownerId`'s attendee row on `eventId`: a fresh game in
 * the owner's collection, put on their list for the event. The owner must
 * already attend the event. List entries grant nothing, so arranging them
 * after the actors' first requests is safe.
 *
 * The collection entry is the game-collection suites' own fixture, kept at the
 * schema's default reach, so a change to how a collection entry is
 * arranged lands in one place.
 *
 * The result is exactly a direct-add body's two required fields, so a spec can
 * send it as is.
 *
 * Extracted when a second suite needed it (#558), on the concrete-first rule
 * `../support/wire.ts` describes.
 */
export async function arrangeListEntry(
  prisma: PrismaClient,
  eventId: string,
  ownerId: string,
): Promise<{ platformGameId: string; suppliedById: string }> {
  const collectionId = await arrangeCollectionEntry(prisma, ownerId, Reach.Private);
  const { platformGameId } = await prisma.gameCollection.findUniqueOrThrow({
    where: { id: collectionId },
    select: { platformGameId: true },
  });
  const attendee = await prisma.eventAttendee.findUniqueOrThrow({
    where: { eventId_userId: { eventId, userId: ownerId } },
    select: { id: true },
  });
  const entry = await prisma.eventAttendeeGameList.create({
    data: { attendeeId: attendee.id, collectionId },
    select: { id: true },
  });

  return { platformGameId, suppliedById: entry.id };
}

/** The facts of an offered game a spec arranges, each left to the schema's default when not given. */
export interface OfferedGameFacts {
  readonly title?: string;
  readonly subtitle?: string | null;
  readonly contentType?: ContentType;
  readonly minPlayers?: number | null;
  readonly maxPlayers?: number | null;
  readonly minPlayTime?: number | null;
  readonly maxPlayTime?: number | null;
  readonly publishYear?: number | null;
  readonly medium?: GameMedium;
  /** The offered copy's platform type: the seeded Tabletop platform, or a platform of that type made for the suite. */
  readonly platformType?: PlatformType;
}

/** What {@link arrangeOfferedGame} made, so a spec can name each row it touches. */
export interface ArrangedOfferedGame {
  readonly entryId: string;
  readonly collectionId: string;
  readonly gameId: string;
  readonly platformGameId: string;
}

/**
 * A platform of `platformType`: the seeded Tabletop one, or one this suite
 * makes once by slug. Only Tabletop is seeded, and the offered-games filters
 * need another platform type to tell apart (#1187).
 */
export async function platformOfType(prisma: PrismaClient, platformType: PlatformType): Promise<string> {
  if (platformType === PlatformType.Tabletop) {
    return (await tabletopPlatform(prisma)).id;
  }

  const slug = `e2e-${platformType.toLowerCase()}`;
  const platform = await prisma.platform.upsert({
    where: { slug },
    create: { name: `e2e ${platformType}`, slug, platformType },
    update: {},
    select: { id: true },
  });

  return platform.id;
}

/**
 * An offered game on `eventId`, arranged directly in the database (#1187): a
 * fresh game with `facts`, on a platform of the type named, in `ownerId`'s
 * collection, offered by `ownerId`'s attendee row, or by
 * `attendeeId` when given. A guest added by name has no user, so their offer
 * names its attendee and someone else's collection entry, as a host's offer
 * for them does today (#1210).
 */
export async function arrangeOfferedGame(
  prisma: PrismaClient,
  options: { eventId: string; ownerId: string; attendeeId?: string } & OfferedGameFacts,
): Promise<ArrangedOfferedGame> {
  const { eventId, ownerId, medium = GameMedium.Physical, platformType = PlatformType.Tabletop, ...facts } = options;
  const game = await prisma.game.create({
    data: {
      title: facts.title ?? `e2e game ${randomUUID().slice(0, 8)}`,
      subtitle: facts.subtitle ?? null,
      contentType: facts.contentType ?? ContentType.BaseGame,
      minPlayers: facts.minPlayers ?? null,
      maxPlayers: facts.maxPlayers ?? null,
      minPlayTime: facts.minPlayTime ?? null,
      maxPlayTime: facts.maxPlayTime ?? null,
      publishYear: facts.publishYear ?? null,
    },
    select: { id: true },
  });
  const platformGame = await prisma.platformGame.create({
    data: { gameId: game.id, platformId: await platformOfType(prisma, platformType) },
    select: { id: true },
  });
  const collection = await prisma.gameCollection.create({
    data: { userId: ownerId, platformGameId: platformGame.id, medium },
    select: { id: true },
  });
  const attendeeId =
    options.attendeeId ??
    (
      await prisma.eventAttendee.findUniqueOrThrow({
        where: { eventId_userId: { eventId, userId: ownerId } },
        select: { id: true },
      })
    ).id;
  const entry = await prisma.eventAttendeeGameList.create({
    data: { attendeeId, collectionId: collection.id },
    select: { id: true },
  });

  return { entryId: entry.id, collectionId: collection.id, gameId: game.id, platformGameId: platformGame.id };
}
