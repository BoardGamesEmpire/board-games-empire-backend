import {
  EventParticipationStatus,
  EventSchedulingMode,
  EventStatus,
  FriendshipStatus,
  Reach,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { arrangeFriendship, befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { BROWSE_PATH, createEventClient, EVENTS_PATH } from './event-request';
import { attendeeEnvelope, listEventsEnvelope, type ListEventsEnvelope } from './event-wire';

/**
 * `GET /api/events/browse` over the real route (#962): the upcoming events
 * the acting user can read and has no attendee row on, soonest first.
 *
 * Each case that leaves an event out shows, by a read of `GET /api/events/:id`,
 * that the same user still reads it, wherever they still can: the
 * event is narrowed out of the list, not withdrawn. Without that control, a
 * list that lost the event because they lost all access to it would
 * pass too.
 *
 * The assertions check only this test's events, whether each is on the page
 * and in what order, never the whole page or `total`. Every page asks for 100
 * rows and the dates fall within the next few hours, so this test's events
 * land on the first page.
 */
describe('browsing upcoming events (#962)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const { createdEventId } = createEventClient(baseUrl);

  /** `hours` from now, as the wire sends a date. */
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  /** One Confirmed date starting `start` hours from now, ending `end` hours from now if given. */
  const dated = (start: number, end?: number) => ({
    occurrences: [{ startDate: soon(start), ...(end === undefined ? {} : { endDate: soon(end) }) }],
  });

  const browsePage = async (caller: Caller, query = '?limit=100'): Promise<ListEventsEnvelope> =>
    listEventsEnvelope(
      await request(baseUrl).get(`${BROWSE_PATH}${query}`).set(caller.headers).expect(200),
      `GET /api/events/browse${query}`,
    );

  /** The ids on the first page served to `caller`, in order. */
  const browse = async (caller: Caller) => (await browsePage(caller)).events.map((event) => event.id);

  const readEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  it("lists a stranger's upcoming Public event, and leaves out a Friends one", async () => {
    const [host, viewer] = await Promise.all([actors.user(), actors.user()]);
    const publicId = await createdEventId(host, { reach: Reach.Public, ...dated(2) });
    const friendsId = await createdEventId(host, { reach: Reach.Friends, ...dated(2) });

    const ids = await browse(viewer);

    expect(ids).toContain(publicId);
    expect(ids).not.toContain(friendsId);
  });

  it("lists a friend's event that reaches friends, and a friend of a friend's that reaches friends of friends", async () => {
    const [viewer, friend, friendOfFriend] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    await befriend(db.client, viewer, friend);
    await befriend(db.client, friend, friendOfFriend);

    const friendsId = await createdEventId(friend, { reach: Reach.Friends, ...dated(2) });
    const friendsOfFriendsId = await createdEventId(friendOfFriend, { reach: Reach.FriendsOfFriends, ...dated(2) });
    // A friend of a friend's event that reaches only their friends doesn't
    // reach the viewer.
    const notReachingId = await createdEventId(friendOfFriend, { reach: Reach.Friends, ...dated(2) });

    const ids = await browse(viewer);

    expect(ids).toEqual(expect.arrayContaining([friendsId, friendsOfFriendsId]));
    expect(ids).not.toContain(notReachingId);
  });

  // The household arm needs a live household. A member holding the Admin
  // role reads every event, so only the browse scope can leave the deleted
  // household's event out of their list, and they still read it by id.
  // Private, so only membership lists it. A soft-deleted household's event
  // whose reach admits others stays listed through that reach (#962).
  it("lists an upcoming event of the acting user's household, whatever its reach, and stops listing it through a soft-deleted household", async () => {
    const [owner, member, admin] = await Promise.all([actors.user(), actors.user(), actors.admin()]);
    const { household } = await actors.householdWithMembers({
      owner,
      members: [
        { actor: member, role: SystemRole.HouseholdMember },
        { actor: admin, role: SystemRole.HouseholdMember },
      ],
    });
    const eventId = await createdEventId(owner, { householdId: household.id, reach: Reach.Private, ...dated(2) });

    expect(await browse(member)).toContain(eventId);
    expect(await browse(admin)).toContain(eventId);

    await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

    await readEvent(admin, eventId).expect(200);
    expect(await browse(member)).not.toContain(eventId);
    expect(await browse(admin)).not.toContain(eventId);
  });

  // Any row keeps the event out, a removed one included, so a host's removal
  // doesn't put the event back on the removed person's home page.
  it('leaves out an event the acting user hosts, is invited to, has declined, or was removed from', async () => {
    const [host, invited, decliner, removed, stranger] = await Promise.all([
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);
    const eventId = await createdEventId(host, { reach: Reach.Public, ...dated(2) });

    await addAttendee(host, eventId, { userId: invited.user.id }).expect(201);
    const declined = attendeeEnvelope(
      await addAttendee(host, eventId, { userId: decliner.user.id }).expect(201),
      'POST /api/events/:eventId/attendees for the decliner',
    );
    await request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}/attendees/${declined.id}/status`)
      .set(decliner.headers)
      .send({ status: EventParticipationStatus.NotAttending })
      .expect(200);
    const removedRow = attendeeEnvelope(
      await addAttendee(host, eventId, { userId: removed.user.id }).expect(201),
      'POST /api/events/:eventId/attendees for the removed attendee',
    );
    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${removedRow.id}`).set(host.headers).expect(200);

    // The control: someone with no row sees it listed.
    expect(await browse(stranger)).toContain(eventId);

    const attendees = [
      ['its host', host],
      ['an invited attendee', invited],
      ['an attendee who declined', decliner],
      ['an attendee the host removed', removed],
    ] as const;

    for (const [who, actor] of attendees) {
      await readEvent(actor, eventId).expect(200);
      expect({ who, listed: (await browse(actor)).includes(eventId) }).toEqual({ who, listed: false });
    }
  });

  it('leaves out a past event, a cancelled one, an archived one, a deleted one, and one with no date', async () => {
    const [host, viewer] = await Promise.all([actors.user(), actors.user()]);
    const publicEvent = (body: Record<string, unknown> = {}) =>
      createdEventId(host, { reach: Reach.Public, ...dated(2), ...body });

    const upcomingId = await publicEvent();
    const pastId = await publicEvent(dated(-3, -2));
    const cancelledId = await publicEvent();
    const archivedId = await publicEvent();
    const deletedId = await publicEvent();
    const undatedId = await publicEvent({ occurrences: [] });
    // A poll's proposed date isn't a date the event has yet, and neither is
    // a confirmed one with an end but no start.
    const pollId = await publicEvent({ schedulingMode: EventSchedulingMode.Poll });
    const startlessId = await publicEvent({ occurrences: [{ endDate: soon(3) }] });

    await request(baseUrl).post(`${EVENTS_PATH}/${cancelledId}/cancel`).set(host.headers).send({}).expect(200);
    // No route archives an event with a date still ahead: archiving takes a
    // cancelled event or one whose dates have all passed, and either is left
    // out already. Arranged directly, so the archive alone keeps it out.
    await db.client.event.update({ where: { id: archivedId }, data: { archivedAt: new Date() } });
    await request(baseUrl).delete(`${EVENTS_PATH}/${deletedId}`).set(host.headers).expect(200);

    const ids = await browse(viewer);
    const leftOut = { pastId, cancelledId, archivedId, deletedId, undatedId, pollId, startlessId };

    expect(ids).toContain(upcomingId);
    for (const [which, id] of Object.entries(leftOut)) {
      expect({ which, listed: ids.includes(id) }).toEqual({ which, listed: false });
    }

    // The control: each one left out that the viewer can still read by id.
    for (const id of [pastId, cancelledId, archivedId, undatedId, pollId, startlessId]) {
      await readEvent(viewer, id).expect(200);
    }
  });

  // A date ends at its end, or at its start when it has none: the window an
  // event's status is worked out from, so a listed row reads Scheduled or
  // Ongoing.
  it('lists an ongoing event, and leaves out a date with no end that started a minute ago', async () => {
    const [host, viewer] = await Promise.all([actors.user(), actors.user()]);
    const ongoingId = await createdEventId(host, { reach: Reach.Public, ...dated(-1, 1) });
    const scheduledId = await createdEventId(host, { reach: Reach.Public, ...dated(2) });
    const endedId = await createdEventId(host, { reach: Reach.Public, ...dated(-1 / 60) });

    const { events } = await browsePage(viewer);
    const statusOf = (id: string) => events.find((event) => event.id === id)?.status;

    expect(statusOf(ongoingId)).toBe(EventStatus.Ongoing);
    expect(statusOf(scheduledId)).toBe(EventStatus.Scheduled);
    expect(events.map((event) => event.id)).not.toContain(endedId);
    await readEvent(viewer, endedId).expect(200);
  });

  // A multi-day event whose first day is past sorts by the day still ahead,
  // and still carries every one of its dates, the ended one included.
  it("orders by each event's soonest date that hasn't ended", async () => {
    const [host, viewer] = await Promise.all([actors.user(), actors.user()]);
    const laterId = await createdEventId(host, { reach: Reach.Public, ...dated(3) });
    const soonestId = await createdEventId(host, { reach: Reach.Public, ...dated(1) });
    const multiDayId = await createdEventId(host, {
      reach: Reach.Public,
      schedulingMode: EventSchedulingMode.MultiDay,
      occurrences: [
        { startDate: soon(-3), endDate: soon(-2) },
        { startDate: soon(2), endDate: soon(4) },
      ],
    });

    const { events } = await browsePage(viewer);
    const mine = events.filter((event) => [laterId, soonestId, multiDayId].includes(event.id));

    expect(mine.map((event) => event.id)).toEqual([soonestId, multiDayId, laterId]);
    expect(mine[1]).toEqual(
      expect.objectContaining({
        occurrences: expect.any(Array),
        policy: expect.objectContaining({ eventId: multiDayId }),
      }),
    );
    expect((mine[1] as unknown as { occurrences: unknown[] }).occurrences).toHaveLength(2);
  });

  // `read:event:public` has no block veto (#988), so each event stays
  // readable by id. The list adds one, whichever of the two placed the block.
  it('leaves out a Public event whose host blocked the acting user, or whom they blocked', async () => {
    const [viewer, blocker, blocked, unblocked] = await Promise.all([
      actors.user(),
      actors.user(),
      actors.user(),
      actors.user(),
    ]);
    await arrangeFriendship(db.client, blocker, viewer, FriendshipStatus.Blocked);
    await arrangeFriendship(db.client, viewer, blocked, FriendshipStatus.Blocked);

    const blockersId = await createdEventId(blocker, { reach: Reach.Public, ...dated(2) });
    const blockedsId = await createdEventId(blocked, { reach: Reach.Public, ...dated(2) });
    const unblockedId = await createdEventId(unblocked, { reach: Reach.Public, ...dated(2) });

    await readEvent(viewer, blockersId).expect(200);
    await readEvent(viewer, blockedsId).expect(200);

    const ids = await browse(viewer);

    expect(ids).toContain(unblockedId);
    expect(ids).not.toContain(blockersId);
    expect(ids).not.toContain(blockedsId);
  });

  // Admin and Moderator hold `read:event` with no conditions, and the Owner
  // `manage:all`. Taken as the answer, either would list them every event on
  // the server (#512).
  it('lists elevated users the same kind of list as everyone, not every event on the server', async () => {
    const [serverOwner, admin, moderator, stranger] = await Promise.all([
      actors.owner(),
      actors.admin(),
      actors.moderator(),
      actors.user(),
    ]);
    const privateId = await createdEventId(stranger, { reach: Reach.Private, ...dated(2) });
    const publicId = await createdEventId(stranger, { reach: Reach.Public, ...dated(2) });

    const elevated = [
      ['an admin', admin],
      ['a moderator', moderator],
      ["the server's Owner", serverOwner],
    ] as const;

    for (const [who, actor] of elevated) {
      await readEvent(actor, privateId).expect(200);

      const ids = await browse(actor);
      expect({ who, publicListed: ids.includes(publicId), privateListed: ids.includes(privateId) }).toEqual({
        who,
        publicListed: true,
        privateListed: false,
      });
    }
  });

  // A key's grant keeps its action and type but not the permission's
  // conditions, which the owner's ability stands in for (#266). What limits a
  // key's list is a grant pinned to one event.
  it('limits an API key to its own grants', async () => {
    const [owner, host] = await Promise.all([actors.user(), actors.user()]);
    await befriend(db.client, owner, host);
    const pinnedId = await createdEventId(host, { reach: Reach.Friends, ...dated(2) });
    const otherId = await createdEventId(host, { reach: Reach.Public, ...dated(2) });

    const key = await mintApiKey(baseUrl, db.client, owner, {
      slugs: ['read:event:public'],
      resourceType: ResourceType.Event,
      resourceId: pinnedId,
    });

    // The control: the owner's session lists both.
    expect(await browse(owner)).toEqual(expect.arrayContaining([pinnedId, otherId]));

    const ids = await browse(key);
    expect(ids).toContain(pinnedId);
    expect(ids).not.toContain(otherId);
  });

  // Three events with the same start, so only the id tie-break orders them.
  it('pages without repeats', async () => {
    const [owner, member] = await Promise.all([actors.user(), actors.user()]);
    const { household } = await actors.householdWithMembers({
      owner,
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const startDate = soon(2);
    const mine = new Set<string>();
    for (let i = 0; i < 3; i++) {
      mine.add(await createdEventId(owner, { householdId: household.id, occurrences: [{ startDate }] }));
    }

    const seen: string[] = [];
    for (let page = 1; page <= 100 && seen.length < mine.size; page++) {
      const { events, total } = await browsePage(member, `?limit=1&page=${page}`);
      seen.push(...events.map((event) => event.id).filter((id) => mine.has(id)));
      if (page >= total) {
        break;
      }
    }

    expect([...seen].sort()).toEqual([...mine].sort());
  });
});
