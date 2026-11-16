import { Prisma } from '@bge/database';

/**
 * A platform game as the event routes embed it: the game's id, title,
 * subtitle and thumbnail, and the platform's id, name and type. The lineup and
 * the nominations name a game with its subtitle (#1271).
 *
 * One constant for the nominations and the games on an occurrence, because
 * both serve the same game card and two literals drift apart one field at a
 * time. A field added here reaches both (#558).
 */
export const PLATFORM_GAME_SUMMARY_SELECT = {
  id: true,
  game: { select: { id: true, title: true, subtitle: true, thumbnail: true } },
  platform: { select: { id: true, name: true, platformType: true } },
} as const satisfies Prisma.PlatformGameSelect;
