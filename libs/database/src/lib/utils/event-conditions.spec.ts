import { liveEventWhere } from './event-conditions';

describe('liveEventWhere (#992)', () => {
  // The household relation is optional, so a bare `household: { is: … }`
  // filter would drop every event outside a household.
  it('is an event not deleted, outside any household or in a live one (#992)', () => {
    expect(liveEventWhere()).toEqual({
      deletedAt: null,
      OR: [{ householdId: null }, { household: { is: { deletedAt: null } } }],
    });
  });

  // Callers spread it into their own `where`, so a shared object would let one
  // caller's edit reach another's clause.
  it('builds a new clause on every call', () => {
    expect(liveEventWhere()).not.toBe(liveEventWhere());
  });
});
