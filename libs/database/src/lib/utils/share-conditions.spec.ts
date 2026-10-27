import { blockWith } from './friendship-conditions';
import { gameSharedWith } from './share-conditions';

describe('gameSharedWith', () => {
  it('names the user, from an owner with no block between them, or a live household they belong to, in effect either way', () => {
    expect(gameSharedWith('u-1')).toStrictEqual({
      OR: [
        {
          shares: { some: { userId: 'u-1', approvedAt: { not: null } } },
          createdBy: { is: { NOT: blockWith('u-1') } },
        },
        {
          shares: {
            some: {
              approvedAt: { not: null },
              household: { is: { deletedAt: null, members: { some: { userId: 'u-1' } } } },
            },
          },
        },
      ],
    });
  });

  // The catalog holds one rendering by reference in every entry that uses it,
  // so a shared object would let one consumer's edit reach another's clause.
  it('builds a new clause on every call', () => {
    expect(gameSharedWith('u-1')).not.toBe(gameSharedWith('u-1'));
  });
});
