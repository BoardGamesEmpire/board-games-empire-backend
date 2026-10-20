import { acceptedFriendOf, REACHES_ADMITTING_FRIENDS } from './friendship-conditions';

describe('acceptedFriendOf', () => {
  it('matches an accepted friendship in either direction of the single row', () => {
    expect(acceptedFriendOf('u-1')).toEqual({
      OR: [
        { friendshipsRequested: { some: { addresseeId: 'u-1', status: 'Accepted' } } },
        { friendshipsReceived: { some: { requesterId: 'u-1', status: 'Accepted' } } },
      ],
    });
  });

  // The catalog holds one rendering by reference in every entry that uses it,
  // so a shared object would let one consumer's edit reach another's clause.
  it('builds a new clause on every call', () => {
    expect(acceptedFriendOf('u-1')).not.toBe(acceptedFriendOf('u-1'));
  });
});

describe('REACHES_ADMITTING_FRIENDS', () => {
  it('is Friends and every rung above it', () => {
    expect(REACHES_ADMITTING_FRIENDS).toEqual(['Friends', 'FriendsOfFriends', 'Public']);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(REACHES_ADMITTING_FRIENDS)).toBe(true);
  });
});
