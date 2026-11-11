import { ContentType, GameMedium, PlatformType } from '@bge/database';
import type { OfferedGameEntry } from './offered-game.types';

/** An offered entry as `OFFERED_GAME_SELECT` reads it, of game `gameId`, on `attendeeId`'s list. */
export function makeOfferedGameEntry(id: string, gameId = 'game-1', attendeeId = 'att-1'): OfferedGameEntry {
  return {
    id,
    attendeeId,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    collection: {
      id: `col-${id}`,
      medium: GameMedium.Physical,
      platformGame: {
        id: `pg-${gameId}`,
        image: null,
        thumbnail: null,
        minPlayers: null,
        maxPlayers: null,
        minPlayTime: null,
        maxPlayTime: null,
        platform: { id: 'plat-1', name: 'Tabletop', slug: 'tabletop', platformType: PlatformType.Tabletop },
        game: {
          id: gameId,
          title: `Game ${gameId}`,
          subtitle: null,
          thumbnail: null,
          image: null,
          contentType: ContentType.BaseGame,
          publishYear: null,
          complexity: null,
          minPlayers: 2,
          maxPlayers: 4,
          minPlayTime: 30,
          maxPlayTime: 60,
        },
      },
    },
  };
}
