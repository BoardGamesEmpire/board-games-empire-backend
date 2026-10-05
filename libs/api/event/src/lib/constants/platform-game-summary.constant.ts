import { Prisma } from '@bge/database';

/**
 * A platform game as the event routes embed it: the game's id, title and
 * thumbnail, and the platform's id, name and type.
 *
 * One constant for the nominations and the games on an occurrence, because
 * both serve the same game card and two literals drift apart one field at a
 * time. A field added here reaches both (#558).
 */
export const PLATFORM_GAME_SUMMARY_SELECT = {
  id: true,
  game: { select: { id: true, title: true, thumbnail: true } },
  platform: { select: { id: true, name: true, platformType: true } },
} as const satisfies Prisma.PlatformGameSelect;
