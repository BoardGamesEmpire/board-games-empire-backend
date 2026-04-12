import type { Game, GameRelease, Platform } from '@bge/database';
import { ContentType, TimeMeasure, Visibility } from '@bge/database';

export function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    averageRating: 8.6,
    bayesRating: null,
    complexity: 3.86,
    contentType: ContentType.BaseGame,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    createdById: null,
    deletedAt: null,
    description: null,
    enrichmentSource: null,
    frozenAt: null,
    id: 'game-fixture-1',
    image: null,
    maxPlayers: 4,
    maxPlayTime: 120,
    maxPlayTimeMeasure: TimeMeasure.Minutes,
    minAge: 14,
    minPlayers: 1,
    minPlayTime: 60,
    minPlayTimeMeasure: TimeMeasure.Minutes,
    ownedByCount: 0,
    playingTime: 120,
    publishYear: 2017,
    ratingsCount: null,
    subtitle: null,
    thumbnail: null,
    title: 'Gloomhaven',
    totalPlayCount: 0,
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    visibility: Visibility.Public,
    ...overrides,
  };
}

export function makeGameWithSource(overrides: Partial<GameWithSource> = {}): GameWithSource {
  const game = makeGame(overrides);
  return {
    ...game,
    gameSources: [{ sourceUrl: 'https://example.com/game' }],
    releases: [],
    platforms: [],
    ...overrides,
  };
}

interface GameWithSource extends Game {
  gameSources: { sourceUrl: string }[];
  releases: GameRelease[];
  platforms: Partial<Platform>[];
}
