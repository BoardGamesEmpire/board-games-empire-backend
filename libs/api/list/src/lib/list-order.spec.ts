import { isSameIdSet } from './list-order';

/**
 * #1241. A reorder names the whole set it orders, so a set that has changed
 * since the client read it is refused, never applied in part.
 */
describe('isSameIdSet (#1241)', () => {
  it('accepts the same ids in any order, and an empty set for an empty one (#1241)', () => {
    expect(isSameIdSet(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isSameIdSet([], [])).toBe(true);
  });

  it('refuses a missing id, an extra id, an id it does not hold and a repeated id (#1241)', () => {
    expect(isSameIdSet(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(isSameIdSet(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(isSameIdSet(['a', 'b'], ['a', 'x'])).toBe(false);
    // Same size as the held set, but one id twice and one left out.
    expect(isSameIdSet(['a', 'b'], ['a', 'a'])).toBe(false);
    expect(isSameIdSet(['a', 'b'], ['a', 'b', 'b'])).toBe(false);
  });
});
