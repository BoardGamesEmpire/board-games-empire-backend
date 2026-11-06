import {
  acceptedFriendOf,
  friendOfFriendOf,
  REACHES_ADMITTING_FRIENDS,
  withinExtendedNetworkOf,
} from './friendship-conditions';

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
  // The extended network admits a direct friend through the friends
  // permissions, as friends of friends does (#497).
  it('is Friends and every rung above it', () => {
    expect(REACHES_ADMITTING_FRIENDS).toEqual(['Friends', 'FriendsOfFriends', 'ExtendedNetwork', 'Public']);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(REACHES_ADMITTING_FRIENDS)).toBe(true);
  });
});

describe('friendOfFriendOf', () => {
  // A friend of a friend is one accepted friendship from an accepted friend of
  // `userId`, with each step checked in both directions of its single row. The
  // block veto is there because a block between the two would otherwise be
  // stepped around through a friend they share (#496).
  it('matches an accepted friend of an accepted friend, either direction on each step, unless the pair has a block', () => {
    expect(friendOfFriendOf('u-1')).toEqual({
      OR: [
        { friendshipsRequested: { some: { status: 'Accepted', addressee: { is: acceptedFriendOf('u-1') } } } },
        { friendshipsReceived: { some: { status: 'Accepted', requester: { is: acceptedFriendOf('u-1') } } } },
      ],
      NOT: {
        OR: [
          { friendshipsRequested: { some: { addresseeId: 'u-1', status: 'Blocked' } } },
          { friendshipsReceived: { some: { requesterId: 'u-1', status: 'Blocked' } } },
        ],
      },
    });
  });

  it('builds a new clause on every call', () => {
    expect(friendOfFriendOf('u-1')).not.toBe(friendOfFriendOf('u-1'));
  });
});

describe('withinExtendedNetworkOf', () => {
  // One lookup on the extended network table's key, which a worker job keeps current.
  // The block veto is read from the friendships, so a block takes effect before
  // the job runs (#497).
  it('matches the users the extended network table puts within three steps of userId, with no block between them (#497)', () => {
    expect(withinExtendedNetworkOf('u-1')).toStrictEqual({
      extendedNetwork: { some: { otherUserId: 'u-1', steps: { lte: 3 } } },
      NOT: {
        OR: [
          { friendshipsRequested: { some: { addresseeId: 'u-1', status: 'Blocked' } } },
          { friendshipsReceived: { some: { requesterId: 'u-1', status: 'Blocked' } } },
        ],
      },
    });
  });

  it('builds a new clause on every call', () => {
    expect(withinExtendedNetworkOf('u-1')).not.toBe(withinExtendedNetworkOf('u-1'));
  });
});
