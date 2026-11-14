import type { Prisma } from '@bge/database';

/** The game an entry shows, whether it names the game itself or one of its platform games. */
const ENTRY_GAME_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  image: true,
  thumbnail: true,
  contentType: true,
  publishYear: true,
} as const satisfies Prisma.GameSelect;

/**
 * What a list entry carries to the client: its own columns and what it names,
 * so a client can show a list without fetching each game (#1241). An entry
 * names a game or a platform game, so exactly one of `game` and `platformGame`
 * is set, and a platform game brings its platform and its game. Each field is
 * named, so no column ships by default (#460).
 *
 * What an entry names is read with it, under no ceiling of its own, as a
 * collection row's platform game is: whoever may read the list sees what its
 * owner put on it.
 */
export const LIST_ENTRY_SELECT = {
  id: true,
  listId: true,
  gameId: true,
  platformGameId: true,
  releaseId: true,
  position: true,
  priority: true,
  note: true,
  createdAt: true,
  updatedAt: true,
  game: { select: ENTRY_GAME_SELECT },
  platformGame: {
    select: {
      id: true,
      image: true,
      thumbnail: true,
      platform: { select: { id: true, name: true, slug: true, platformType: true } },
      game: { select: ENTRY_GAME_SELECT },
    },
  },
  release: { select: { id: true, editionName: true, releaseYear: true } },
} as const satisfies Prisma.ListEntrySelect;

export type ListEntryRow = Prisma.ListEntryGetPayload<{ select: typeof LIST_ENTRY_SELECT }>;
