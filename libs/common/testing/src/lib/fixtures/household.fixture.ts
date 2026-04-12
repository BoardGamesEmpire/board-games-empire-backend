import type { Household, HouseholdMember } from '@bge/database';
import { sequence } from './sequence.js';

export function makeHousehold(overrides: Partial<Household> = {}): Household {
  const n = sequence();
  return <Household>{
    id: `household-${n}`,
    name: `Household ${n}`,
    description: null,
    image: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeHouseholdMember(
  overrides: Partial<HouseholdMember> & Required<Pick<HouseholdMember, 'userId' | 'householdId'>>,
): HouseholdMember {
  return {
    id: `hm-${sequence()}`,
    showAllGames: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
