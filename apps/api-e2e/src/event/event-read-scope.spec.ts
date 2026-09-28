import { EventParticipationStatus, SystemRole, Visibility } from '@bge/database';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  attendeeEnvelope,
  availabilitySummaryEnvelope,
  eventEnvelope,
  listEventsEnvelope,
  type ListEventsEnvelope,
} from './event-wire';

/**
 * What the event reads return, over the real routes (#512).
 *
 * `GET /api/events` lists the events the caller is an attendee of. Until
 * #512 the caller's ceiling was the whole query, so staff were listed every
 * event on the server, a household member every event in their households,
 * and a friend their friends' `Friends`-visible events. Each narrowing below
 * follows a by-id read showing the same caller still reads the event the list
 * leaves out: narrowed out of the list, not withdrawn. Without that control, a
 * list that lost the event because the caller lost all access to it would
 * pass too.
 *
 * Events are created through `POST /api/events`, so the host's attendee row
 * is the one the create path writes. The list is response-cached per caller
 * and URL, so no test lists for an actor before the writes that list must
 * reflect.
 */
describe('event read scope', () => {
  const baseUrl = requireBaseUrl(process.env);
  const EVENTS_PATH = '/api/events';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const createdEventId = async (actor: AuthenticatedActor, body: Record<string, unknown> = {}) =>
    eventEnvelope(
      await request(baseUrl)
        .post(EVENTS_PATH)
        .set(actor.headers)
        .send({ title: `e2e event ${randomUUID().slice(0, 8)}`, ...body })
        .expect(201),
      'POST /api/events',
    ).id;

  const readEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  const listEvents = (actor: AuthenticatedActor) => request(baseUrl).get(EVENTS_PATH).set(actor.headers);

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  const readSummary = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}/occurrences/summary/availability`).set(actor.headers);

  /** Sorted, since the assertions are about which events, not their order. */
  const idsOf = (page: ListEventsEnvelope) => page.events.map((event) => event.id).sort();

  describe('listing events (#512)', () => {
    it('lists the events a caller is an attendee of, hosts included, whatever their RSVP', async () => {
      const host = await actors.user();
      const invitee = await actors.user();
      const decliner = await actors.user();
      const firstId = await createdEventId(host);
      const secondId = await createdEventId(host);

      await addAttendee(host, firstId, { userId: invitee.user.id }).expect(201);
      const declined = attendeeEnvelope(
        await addAttendee(host, firstId, { userId: decliner.user.id }).expect(201),
        'POST /api/events/:eventId/attendees as the host',
      );
      await request(baseUrl)
        .patch(`${EVENTS_PATH}/${firstId}/attendees/${declined.id}/status`)
        .set(decliner.headers)
        .send({ status: EventParticipationStatus.NotAttending })
        .expect(200);

      const hostPage = listEventsEnvelope(await listEvents(host).expect(200), 'GET /api/events as the host');
      expect(idsOf(hostPage)).toEqual([firstId, secondId].sort());
      expect(hostPage.total).toBe(2);

      // An invitation still listed, and a declined event too: the RSVP changes
      // the row's status and never the event role on it.
      const invitees = [
        ['an invitee', invitee],
        ['an attendee who declined', decliner],
      ] as const;

      for (const [who, actor] of invitees) {
        const page = listEventsEnvelope(await listEvents(actor).expect(200), `GET /api/events as ${who}`);
        expect(idsOf(page)).toEqual([firstId]);
        expect(page.total).toBe(1);
      }
    });

    it('lists staff only the events they attend, while each still reads a stranger’s event by id', async () => {
      const [serverOwner, admin, moderator, plainUser, stranger] = await Promise.all([
        actors.owner(),
        actors.admin(),
        actors.moderator(),
        actors.user(),
        actors.user(),
      ]);

      const strangersId = await createdEventId(stranger);
      const staff = [
        ['an admin', admin, await createdEventId(admin)],
        ['a moderator', moderator, await createdEventId(moderator)],
        ["the server's Owner", serverOwner, await createdEventId(serverOwner)],
      ] as const;

      // The control. Admin and Moderator read the stranger's event through
      // `read:public_content`, and the Owner through `manage:all`. A plain user
      // is refused the same event, so the reads above come from the staff
      // grants and not from the event being open to everyone.
      for (const [who, actor] of staff) {
        const read = eventEnvelope(await readEvent(actor, strangersId).expect(200), `GET /api/events/:id as ${who}`);
        expect(read.id).toBe(strangersId);
      }
      await readEvent(plainUser, strangersId).expect(404);

      for (const [who, actor, ownId] of staff) {
        const page = listEventsEnvelope(await listEvents(actor).expect(200), `GET /api/events as ${who}`);
        expect(idsOf(page)).toEqual([ownId]);
        expect(page.total).toBe(1);
      }
    });

    it("leaves a household event out of a member's list when they don't attend it, though they read it by id", async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const householdEventId = await createdEventId(owner, { householdId: household.id });
      const ownId = await createdEventId(member);

      // Control: the member reads it through the household grant.
      const read = eventEnvelope(
        await readEvent(member, householdEventId).expect(200),
        'GET /api/events/:id as a household member',
      );
      expect(read.id).toBe(householdEventId);

      const page = listEventsEnvelope(await listEvents(member).expect(200), 'GET /api/events as a household member');
      expect(idsOf(page)).toEqual([ownId]);
      expect(page.total).toBe(1);
    });

    it("leaves a friend's Friends-visible event out of the list, though the friend reads it by id", async () => {
      const friend = await actors.user();
      const viewer = await actors.user();
      await befriend(db.client, viewer, friend);

      const friendsEventId = await createdEventId(friend, { visibility: Visibility.Friends });
      const ownId = await createdEventId(viewer);

      // Control: the viewer reads it through `read:event:friends`.
      const read = eventEnvelope(
        await readEvent(viewer, friendsEventId).expect(200),
        'GET /api/events/:id as a friend',
      );
      expect(read.id).toBe(friendsEventId);

      const page = listEventsEnvelope(await listEvents(viewer).expect(200), 'GET /api/events as a friend');
      expect(idsOf(page)).toEqual([ownId]);
      expect(page.total).toBe(1);
    });
  });

  describe('the availability summary (#512)', () => {
    it("counts no attendees for an event the caller can't read, and every attendee for its host", async () => {
      const host = await actors.user();
      const guest = await actors.user();
      const outsider = await actors.user();
      const eventId = await createdEventId(host);
      const outsidersEventId = await createdEventId(outsider);
      await addAttendee(host, eventId, { userId: guest.user.id }).expect(201);

      // Control: the host counts both attendees.
      const own = availabilitySummaryEnvelope(
        await readSummary(host, eventId).expect(200),
        'GET /api/events/:eventId/occurrences/summary/availability as the host',
      );
      expect(own.attendees).toEqual({
        total: 2,
        registered: 2,
        guests: 0,
        byStatus: { attending: 1, invited: 1, maybe: 0, notAttending: 0 },
      });
      expect(own.eligibleVoters).toBe(2);

      // Control: the outsider passes the route's check, which asks only whether
      // they may read availability votes on some event. Their own event's
      // summary counts them. The event itself is not theirs to read.
      const outsidersOwn = availabilitySummaryEnvelope(
        await readSummary(outsider, outsidersEventId).expect(200),
        "GET /api/events/:eventId/occurrences/summary/availability for the outsider's own event",
      );
      expect(outsidersOwn.attendees.total).toBe(1);
      await readEvent(outsider, eventId).expect(404);

      const other = availabilitySummaryEnvelope(
        await readSummary(outsider, eventId).expect(200),
        "GET /api/events/:eventId/occurrences/summary/availability for another host's event",
      );
      expect(other.attendees).toEqual({
        total: 0,
        registered: 0,
        guests: 0,
        byStatus: { attending: 0, invited: 0, maybe: 0, notAttending: 0 },
      });
      expect(other.eligibleVoters).toBe(0);
    });
  });
});
