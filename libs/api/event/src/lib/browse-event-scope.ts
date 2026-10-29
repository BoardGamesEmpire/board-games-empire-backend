import {
  acceptedFriendOf,
  blockWith,
  friendOfFriendOf,
  liveHouseholdOf,
  type Prisma,
  Reach,
  REACHES_ADMITTING_FRIENDS,
} from '@bge/database';

/**
 * The set `GET /events/browse` is about: the events the acting user has no
 * attendee row on, among the Public ones, a friend's that reach friends, a
 * friend of a friend's that reach friends of friends, and their households'
 * (#962). `EventService.browseEvents` declares it through
 * `ScopeComposer.compose`, so the acting user's ceiling limits it.
 *
 * It is the same set for every role. Taking the ceiling as the answer would list
 * Admin and Moderator every event on the server through `read:event`, the
 * widening #512 removed from `GET /events`. The friends and friends-of-friends
 * arms name the friendships themselves, so staff are listed their own
 * friends' events and no one else's. An event staff can read stays readable
 * by id. It is narrowed out of the list, not withdrawn.
 *
 * Any attendee row keeps an event out, a removed one included. The list is
 * the events the acting user could join, and a host's removal shouldn't put
 * the event back on the removed person's home page.
 *
 * - The Public arm vetoes a block between the acting user and the host,
 *   whichever placed it, so someone they blocked can't put events on their
 *   home page. `read:event:public` has no veto, so the event stays readable
 *   by id. Whether the permission should have one is #988's.
 * - The friends arms leave blocks out by construction, as their permissions'
 *   conditions do.
 * - The friends-of-friends arm is shaped as its permission's condition is,
 *   the reach test first in an `AND`: the second friendship step runs once
 *   per row it reaches, so it should reach only the events at
 *   `FriendsOfFriends`.
 * - The household arm needs a membership in a live household,
 *   `liveHouseholdOf`'s. It checks no block: the event belongs to the
 *   household, which already shows it to the member. A soft-deleted
 *   household's event leaves the list only through this arm: one whose reach
 *   admits others stays on it through theirs, as it stays readable by id.
 *
 * `deletedAt` and "upcoming" are `upcomingEventWhere`'s. This scope says
 * which events, and that one says when.
 */
export function browseEventScope(subjectId: string): Prisma.EventWhereInput {
  return {
    attendees: { none: { userId: subjectId } },
    OR: [
      { reach: Reach.Public, createdBy: { is: { NOT: blockWith(subjectId) } } },
      { reach: { in: [...REACHES_ADMITTING_FRIENDS] }, createdBy: { is: acceptedFriendOf(subjectId) } },
      { AND: [{ reach: Reach.FriendsOfFriends }, { createdBy: { is: friendOfFriendOf(subjectId) } }] },
      { household: { is: liveHouseholdOf(subjectId) } },
    ],
  };
}
