import { changedKeys } from './pick-snapshot.util';

describe('changedKeys', () => {
  // #728: an audit row records the columns whose values changed, so a Date
  // compares by value, not by reference.
  it('treats two equal Date instances as unchanged', () => {
    const before = { startDate: new Date('2026-01-01T00:00:00Z') };
    const after = { startDate: new Date('2026-01-01T00:00:00Z') };

    expect(changedKeys(before, after, ['startDate'])).toEqual([]);
  });

  it('keeps only the keys whose values differ', () => {
    expect(changedKeys({ title: 'a', location: 'x' }, { title: 'b', location: 'x' }, ['title', 'location'])).toEqual([
      'title',
    ]);
  });

  it('includes a key that went from null to a value', () => {
    const before: { location: string | null } = { location: null };

    expect(changedKeys(before, { location: 'x' }, ['location'])).toEqual(['location']);
  });
});
