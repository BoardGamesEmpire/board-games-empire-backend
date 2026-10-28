import { gamePoolEntryScope } from './game-pool-scope';

describe('gamePoolEntryScope', () => {
  // #960: the exclusion and the collection sharing are tied to the same
  // household, which the permission catalog's household rule cannot do.
  it('admits an entry per household: its owner shares their collection there and has not excluded it there (#960)', () => {
    expect(gamePoolEntryScope(['hh-a', 'hh-b'])).toEqual({
      deletedAt: null,
      OR: ['hh-a', 'hh-b'].map((householdId) => ({
        user: { is: { householdMember: { some: { householdId, showAllGames: true } } } },
        excludedFromHouseholds: { none: { householdMember: { is: { householdId } } } },
      })),
    });
  });

  it('admits nothing for no households', () => {
    expect(gamePoolEntryScope([])).toEqual({ deletedAt: null, OR: [] });
  });
});
