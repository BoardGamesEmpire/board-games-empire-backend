import type { GameCollection } from '@bge/database';
import { sequence } from './sequence.js';

export function makeGameCollection(
  userId: string,
  gameId: string,
  overrides: Partial<GameCollection> = {},
): GameCollection {
  return <GameCollection>{
    id: `gc-${sequence()}`,
    userId,
    gameId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
