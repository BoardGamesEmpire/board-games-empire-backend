import {
  acceptedFriendOf,
  blockWith,
  friendOfFriendOf,
  liveHouseholdOf,
  PERMISSION_CATALOG,
  Reach,
} from '@bge/database';
import { browseEventScope } from './browse-event-scope';

/**
 * The browse scope is pinned here, once. `EventService.browseEvents` asserts
 * that it passes it through, so a change to the set is one edit and one
 * failing spec (#962).
 */
describe('browseEventScope (#962)', () => {
  it("declares the events the acting user has no attendee row on, among the Public ones, a friend's that reach friends, a friend of a friend's that reach friends of friends, and their households'", () => {
    expect(browseEventScope('u-1')).toEqual({
      attendees: { none: { userId: 'u-1' } },
      OR: [
        { reach: Reach.Public, createdBy: { is: { NOT: blockWith('u-1') } } },
        { reach: { in: ['Friends', 'FriendsOfFriends', 'Public'] }, createdBy: { is: acceptedFriendOf('u-1') } },
        { AND: [{ reach: Reach.FriendsOfFriends }, { createdBy: { is: friendOfFriendOf('u-1') } }] },
        { household: { is: liveHouseholdOf('u-1') } },
      ],
    });
  });

  // Built for the catalog's own placeholder, each friends arm is the condition
  // of the permission `User` reads that set by. A condition the list stops
  // following fails here, rather than leaving an event a user can read by id
  // but never browse to.
  it.each([
    ["a friend's that reach friends", 'read:event:friends', 1],
    ["a friend of a friend's that reach friends of friends", 'read:event:friends-of-friends', 2],
  ])('declares %s exactly as %s reads them', (_set, slug, arm) => {
    expect(browseEventScope('{{ user.id }}').OR?.[arm]).toStrictEqual(
      PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.conditions,
    );
  });

  // The permission has no block veto, and whether it should is #988's. The list
  // adds one, so someone the acting user blocked can't put events on their home
  // page.
  it('declares the Public arm as read:event:public reads it, with a block with the host vetoing it', () => {
    const publicConditions = PERMISSION_CATALOG.find((entry) => entry.slug === 'read:event:public')?.conditions;

    expect(browseEventScope('u-1').OR?.[0]).toEqual({
      ...publicConditions,
      createdBy: { is: { NOT: blockWith('u-1') } },
    });
  });

  // A host's removal leaves the row in place, and it keeps the event out too:
  // otherwise the removal would put the event back on the removed person's
  // home page.
  it('keeps out every event with a row for the acting user, a removed one included', () => {
    expect(browseEventScope('u-1').attendees).toEqual({ none: { userId: 'u-1' } });
  });
});
