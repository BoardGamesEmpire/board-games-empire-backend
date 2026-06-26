import type { GameData } from '@boardgamesempire/proto-gateway';

/**
 * Helper used by GameImportProcessor to extract GameData from its
 * fetch child's return value.
 */
export function extractGameDataFromChildren(childValues: Record<string, unknown>): GameData {
  const gameData = Object.values(childValues).find(
    (value): value is GameData =>
      value !== null && typeof value === 'object' && 'externalId' in value && 'title' in value,
  );

  if (!gameData) {
    throw new Error('No GameData found in child values — fetch child either failed or returned wrong shape');
  }

  return gameData;
}
