import { acceptedFriendOf, friendOfFriendOf, PERMISSION_CATALOG, Reach } from '@bge/database';
import { gameListScope } from './game-list-scope';

/**
 * The list scope is pinned here, once. The services that compose it assert
 * that they pass it through, so a change to the set is one edit and one
 * failing spec.
 */
describe('gameListScope', () => {
  it("declares the live Public games, the acting user's own, a friend's that reach friends, and a friend of a friend's that reach friends of friends", () => {
    expect(gameListScope('u-1')).toEqual({
      deletedAt: null,
      OR: [
        { reach: Reach.Public },
        { createdById: 'u-1' },
        { reach: { in: ['Friends', 'FriendsOfFriends', 'Public'] }, createdBy: { is: acceptedFriendOf('u-1') } },
        { AND: [{ reach: Reach.FriendsOfFriends }, { createdBy: { is: friendOfFriendOf('u-1') } }] },
      ],
    });
  });

  // Built for the catalog's own placeholder, each branch, with the scope's
  // `deletedAt`, is the rule `User` reads that set by. A rule the list stops
  // following fails here, rather than leaving a game a user can read by id
  // but not find.
  it.each([
    ['the Public games', 'read:game:public', 0],
    ["the acting user's own", 'read:game', 1],
    ["a friend's that reach friends", 'read:game:friends', 2],
    ["a friend of a friend's that reach friends of friends", 'read:game:friends-of-friends', 3],
  ])('declares %s exactly as %s reads them', (_set, slug, branch) => {
    const { deletedAt, OR } = gameListScope('{{ user.id }}');

    expect({ deletedAt, ...OR?.[branch] }).toStrictEqual(
      PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions,
    );
  });
});
