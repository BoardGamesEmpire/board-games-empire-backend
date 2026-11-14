import { ListKind, PlatformType, Reach, type List, type PrismaClient } from '@bge/database';
import { randomUUID } from 'node:crypto';

/** What a spec may choose about a list it arranges; the rest takes the schema's defaults. */
export interface ArrangeListOptions {
  readonly kind?: ListKind;
  readonly reach?: Reach;
  /** Defaults to a unique name for a Custom list and to none for a Wishlist, which may go unnamed (#1241). */
  readonly name?: string | null;
  readonly description?: string;
  readonly position?: number;
}

/** The ids a spec needs from an arranged platform game. */
export interface ArrangedPlatformGame {
  readonly gameId: string;
  readonly platformGameId: string;
}

/** Writes a list straight through the database client, so a spec can set up rows no route may create. */
export function arrangeList(prisma: PrismaClient, ownerId: string, options: ArrangeListOptions = {}): Promise<List> {
  const kind = options.kind ?? ListKind.Custom;
  const name = options.name !== undefined ? options.name : kind === ListKind.Custom ? uniqueName('e2e list') : null;

  return prisma.list.create({
    data: {
      userId: ownerId,
      kind,
      name,
      ...(options.reach !== undefined && { reach: options.reach }),
      ...(options.description !== undefined && { description: options.description }),
      ...(options.position !== undefined && { position: options.position }),
    },
  });
}

/** A game with no platform game. `createdById` is optional on a game. */
export function arrangeGame(
  prisma: PrismaClient,
  options: { createdById?: string; reach?: Reach } = {},
): Promise<{ id: string }> {
  return prisma.game.create({
    data: {
      title: uniqueName('e2e game'),
      reach: options.reach ?? Reach.Public,
      ...(options.createdById !== undefined && { createdById: options.createdById }),
    },
    select: { id: true },
  });
}

/**
 * A game with one platform game on a platform of its own, or a further platform
 * game of `gameId` when one is given.
 */
export async function arrangePlatformGame(
  prisma: PrismaClient,
  options: { gameId?: string } = {},
): Promise<ArrangedPlatformGame> {
  const gameId = options.gameId ?? (await arrangeGame(prisma)).id;
  const token = randomUUID().slice(0, 8);
  const platform = await prisma.platform.create({
    data: { name: `e2e platform ${token}`, slug: `e2e-platform-${token}`, platformType: PlatformType.Other },
    select: { id: true },
  });
  const platformGame = await prisma.platformGame.create({
    data: { gameId, platformId: platform.id },
    select: { id: true },
  });

  return { gameId, platformGameId: platformGame.id };
}

function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}
