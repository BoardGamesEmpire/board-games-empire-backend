import { GameMedium, type PrismaClient, type Visibility } from '@bge/database';
import { randomUUID } from 'node:crypto';

/**
 * One collection entry for `ownerId`, arranged directly in the database, on a
 * game of its own so the user × platform game × medium key never collides.
 * The platform is seeded reference data and survives the sweep; the game is
 * created per call.
 *
 * Extracted when a second suite needed it (#514), on the concrete-first rule
 * `../support/wire.ts` describes.
 */
export async function arrangeCollectionEntry(
  prisma: PrismaClient,
  ownerId: string,
  visibility: Visibility,
): Promise<string> {
  const platform = await prisma.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true } });
  const game = await prisma.game.create({
    data: { title: `e2e game ${randomUUID().slice(0, 8)}` },
    select: { id: true },
  });
  const platformGame = await prisma.platformGame.create({
    data: { gameId: game.id, platformId: platform.id },
    select: { id: true },
  });

  const entry = await prisma.gameCollection.create({
    data: { userId: ownerId, platformGameId: platformGame.id, medium: GameMedium.Physical, visibility },
    select: { id: true },
  });

  return entry.id;
}
