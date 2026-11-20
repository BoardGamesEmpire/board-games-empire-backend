import { isSameConfigDocument } from './same-config-document';

describe('isSameConfigDocument (#903)', () => {
  it('reads a document with its keys in another order as the same one', () => {
    expect(isSameConfigDocument({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it('reads a changed, added or removed value as a different document', () => {
    expect(isSameConfigDocument({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSameConfigDocument({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(isSameConfigDocument({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(isSameConfigDocument({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
