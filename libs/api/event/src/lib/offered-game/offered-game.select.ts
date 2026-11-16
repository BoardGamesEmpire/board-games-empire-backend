import type { Prisma } from '@bge/database';

/**
 * An offered game as the reads and the add serve it (#1185, #1187): the
 * offered-games read, an attendee's games, the add's answer and the attendee
 * routes' embed. The take-back answers with its bare row.
 *
 * - The entry: its id, its attendee's id and when it was offered.
 * - Its collection entry: the id and the medium, and nothing else from the
 *   owner's row. Their rating, comment, play count and quantity are theirs,
 *   not the event's. A column added to `GameCollection` later reaches no
 *   offered game unless it's named here.
 * - The platform game, with its own image and its overrides of players and
 *   play time, on its platform.
 * - The game itself.
 *
 * The game's base games, and what the entry supplies, are read on their own
 * under their own ceilings, never through this select (#559).
 */
export const OFFERED_GAME_SELECT = {
  id: true,
  attendeeId: true,
  createdAt: true,

  collection: {
    select: {
      id: true,
      medium: true,

      platformGame: {
        select: {
          id: true,
          image: true,
          thumbnail: true,
          minPlayers: true,
          maxPlayers: true,
          minPlayTime: true,
          maxPlayTime: true,

          platform: {
            select: { id: true, name: true, slug: true, platformType: true },
          },

          game: {
            select: {
              id: true,
              title: true,
              subtitle: true,
              thumbnail: true,
              image: true,
              contentType: true,
              publishYear: true,
              complexity: true,
              minPlayers: true,
              maxPlayers: true,
              minPlayTime: true,
              maxPlayTime: true,
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.EventAttendeeGameListSelect;

/**
 * Offered games in game title order, the client's default, made total by the
 * entry's id so a page holds still between requests (#1187).
 */
export const OFFERED_GAME_ORDER = [
  { collection: { platformGame: { game: { title: 'asc' } } } },
  { id: 'asc' },
] satisfies Prisma.EventAttendeeGameListOrderByWithRelationInput[];
