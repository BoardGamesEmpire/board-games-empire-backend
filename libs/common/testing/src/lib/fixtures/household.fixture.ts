import type { Household, HouseholdMember } from '@bge/database';
import { sequence } from './sequence.js';

export function makeHousehold(overrides: Partial<Household> = {}): Household {
  const n = sequence();
  return <Household>{
    id: `household-${n}`,
    name: `Household ${n}`,
    description: null,
    image: null,
    createdById: `user-${n}`,
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
    // NULL, not a synthetic consent path (#276). A fixture row is not produced
    // by anyone accepting or approving anything, and NULL is precisely how the
    // model says "created outside a consent path". Defaulting to a real origin
    // would make every fixture assert a provenance that never happened — and a
    // test for the seam's own provenance writing could then pass against a row
    // the seam never touched. It would also burn a `sequence()` on a synthetic
    // actor id, desynchronizing the `household-N` / `user-N` correlation
    // `makeHousehold` relies on.
    origin: null,
    addedById: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
