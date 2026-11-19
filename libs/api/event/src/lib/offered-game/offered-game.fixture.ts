import { ContentType, GameMedium, PlatformType } from '@bge/database';
import type { OfferedGameEntry } from './offered-game.types';

/**
 * An offered entry as `OFFERED_GAME_SELECT` reads it, of game `gameId` of
 * `contentType`, on `attendeeId`'s list. Only an add-on's row lists base
 * games (#1391), so an entry meant to show its links passes an add-on type.
 */
export function makeOfferedGameEntry(
  id: string,
  gameId = 'game-1',
  attendeeId = 'att-1',
  contentType: ContentType = ContentType.BaseGame,
): OfferedGameEntry {
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
        contentType: null,
        platform: { id: 'plat-1', name: 'Tabletop', slug: 'tabletop', platformType: PlatformType.Tabletop },
        game: {
          id: gameId,
          title: `Game ${gameId}`,
          subtitle: null,
          thumbnail: null,
          image: null,
          contentType,
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
