import { liveHouseholdOf } from './household-conditions';

describe('liveHouseholdOf (#962)', () => {
  // A deleted household keeps its member rows until it is purged, so the
  // membership alone would still match it.
  it('matches a household the user belongs to that is not soft-deleted', () => {
    expect(liveHouseholdOf('u-1')).toEqual({ deletedAt: null, members: { some: { userId: 'u-1' } } });
  });

  // The catalog holds its rendering by reference, so a shared object would let
  // one consumer's edit reach another's clause.
  it('builds a new clause on every call', () => {
    expect(liveHouseholdOf('u-1')).not.toBe(liveHouseholdOf('u-1'));
  });
});
