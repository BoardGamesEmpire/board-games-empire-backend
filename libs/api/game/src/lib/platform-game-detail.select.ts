import type { Prisma } from '@bge/database';

/**
 * The columns a client gets for each platform game on `GET /games/:id` (#791).
 * Named one by one so a new column stays off the wire until someone adds it
 * here (#460). `enrichmentSource` and `frozenAt` stay out because a client has
 * no use for them.
 */
export const PLATFORM_GAME_DETAIL_SELECT = {
  id: true,
  gameId: true,
  image: true,
  thumbnail: true,
  minPlayers: true,
  maxPlayers: true,
  minPlayTime: true,
  maxPlayTime: true,
  supportsSolo: true,
  supportsLocal: true,
  supportsOnline: true,
  hasAsyncPlay: true,
  hasRealtime: true,
  hasTutorial: true,
  createdAt: true,
  updatedAt: true,
  platform: {
    select: {
      id: true,
      name: true,
      abbreviation: true,
      platformType: true,
    },
  },
} as const satisfies Prisma.PlatformGameSelect;

/** One row of the read {@link PLATFORM_GAME_DETAIL_SELECT} names. */
export type PlatformGameDetail = Prisma.PlatformGameGetPayload<{ select: typeof PLATFORM_GAME_DETAIL_SELECT }>;
