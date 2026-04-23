import type { GameCollection } from '@bge/database';
import { GameMedium } from '@bge/database';
import { sequence } from './sequence.js';

export function makeGameCollection(
  userId: string,
  platformGameId: string,
  overrides: Partial<GameCollection> = {},
): GameCollection {
  return <GameCollection>{
    id: `gc-${sequence()}`,
    userId,
    platformGameId,
    medium: GameMedium.Physical,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
