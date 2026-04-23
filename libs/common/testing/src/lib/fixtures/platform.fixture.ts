import type { Platform, PlatformGame } from '@bge/database';
import { PlatformType } from '@bge/database';
import { sequence } from './sequence.js';

export function makePlatform(overrides: Partial<Platform> = {}): Platform {
  const seq = sequence();
  return {
    id: `platform-${seq}`,
    name: `Platform ${seq}`,
    slug: `platform-${seq}`,
    abbreviation: null,
    platformType: PlatformType.Tabletop,
    isSystem: false,
    logoUrl: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function makeTabletopPlatform(overrides: Partial<Platform> = {}): Platform {
  return makePlatform({
    id: 'platform-tabletop',
    name: 'Tabletop',
    slug: 'tabletop',
    platformType: PlatformType.Tabletop,
    isSystem: true,
    ...overrides,
  });
}

export function makePlatformGame(
  gameId: string,
  platformId: string,
  overrides: Partial<PlatformGame> = {},
): PlatformGame {
  return {
    id: `pg-${sequence()}`,
    gameId,
    platformId,
    minPlayers: null,
    maxPlayers: null,
    minPlayTime: null,
    minPlayTimeMeasure: null,
    maxPlayTime: null,
    maxPlayTimeMeasure: null,
    image: null,
    thumbnail: null,
    supportsSolo: false,
    supportsLocal: false,
    supportsOnline: false,
    hasAsyncPlay: false,
    hasRealtime: false,
    hasTutorial: false,
    enrichmentSource: null,
    frozenAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
