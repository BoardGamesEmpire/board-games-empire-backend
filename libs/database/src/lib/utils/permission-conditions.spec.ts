import { hasBoundingConditions } from './permission-conditions';

describe('hasBoundingConditions', () => {
  it.each<[string, unknown, boolean]>([
    ['a templated clause', { householdId: '{{ unit.householdId }}' }, true],
    ['a static clause', { visibility: 'public' }, true],
    ['an empty object', {}, false],
    ['null (the seed default)', null, false],
    ['undefined (row shapes without the column)', undefined, false],
    ['a non-object', 'ownerId', false],
  ])('%s -> %s', (_label, conditions, expected) => {
    expect(hasBoundingConditions(conditions)).toBe(expected);
  });
});
