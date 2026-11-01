import { EventParticipationStatus, Reach, ResourceType, SystemRole } from '@bge/database';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { attendeesPath, BROWSE_PATH, createEventClient, EVENTS_PATH } from './event-request';
import {
  attendeeEnvelope,
  eventDetailEnvelope,
  listAttendeesEnvelope,
  listEventsEnvelope,
  type EventAttendanceWire,
  type EventDetailWire,
  type EventReadWire,
} from './event-wire';

/**
 * `attendance` over the real routes (#867): how the acting user attends each
 * event they read. It comes from a read of its own, under the attendee ceiling, and
 * only the real CASL extension enforces a deny-all ceiling, so the API key case
 * below is the one no unit test can stand in for.
 *
 * The attendee ids are read back from `GET /api/events/:eventId/attendees`, so
 * each case compares against the row the attendee routes serve.
 */
describe("the acting user's attendance on event reads (#867)", () => {
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

  const { createdEventId, listAttendees } = createEventClient(baseUrl);

  /** `caller`'s row for `eventId` on the first page of `path`, failing the test if it isn't listed. */
  const listedRow = async (caller: Caller, path: string, eventId: string): Promise<EventReadWire> => {
    const { events } = listEventsEnvelope(
      await request(baseUrl).get(`${path}?limit=100`).set(caller.headers).expect(200),
      `GET ${path}?limit=100`,
    );
    const row = events.find(({ id }) => id === eventId);

    if (row === undefined) {
      throw new Error(`event ${eventId} is not on the page ${path} served`);
    }

    return row;
  };

  const attendanceOnList = async (caller: Caller, eventId: string) =>
    (await listedRow(caller, EVENTS_PATH, eventId)).attendance;

  const readDetail = async (caller: Caller, eventId: string): Promise<EventDetailWire> =>
    eventDetailEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(caller.headers).expect(200),
      'GET /api/events/:id',
    );

  /** The id of `actor`'s attendee row, as `reader` is served it by the attendee routes. */
  const attendeeIdOf = async (reader: AuthenticatedActor, eventId: string, actor: AuthenticatedActor) => {
    const { attendees } = listAttendeesEnvelope(
      await listAttendees(reader, eventId, { limit: 100 }).expect(200),
      'GET /api/events/:eventId/attendees',
    );
    const row = attendees.find(({ userId }) => userId === actor.user.id);

    if (row === undefined) {
      throw new Error(`user ${actor.user.id} has no attendee row on event ${eventId}`);
    }

    return row.id;
  };

  const invite = async (host: AuthenticatedActor, eventId: string, attendee: AuthenticatedActor) =>
    attendeeEnvelope(
      await request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({ userId: attendee.user.id })
        .expect(201),
      'POST /api/events/:eventId/attendees',
    ).id;

  const rsvp = (actor: AuthenticatedActor, eventId: string, attendeeId: string, status: EventParticipationStatus) =>
    request(baseUrl)
      .patch(`${attendeesPath(eventId)}/${attendeeId}/status`)
      .set(actor.headers)
      .send({ status })
      .expect(200);

  it('tells a host how they attend, on the list row', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    expect(await attendanceOnList(host, eventId)).toEqual<EventAttendanceWire>({
      attendeeId: await attendeeIdOf(host, eventId, host),
      status: EventParticipationStatus.Attending,
      role: SystemRole.EventHost,
      // Creating an event makes its host an attendee, with no RSVP to date.
      rsvpDate: null,
    });
  });

  // Each read after a write shows the write, so no list row is stale. Only
  // `Attending` and `NotAttending` stamp `rsvpDate`, so `Maybe` leaves it null.
  it("follows an invited attendee's RSVP on the list row", async () => {
    const [host, invited] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const attendeeId = await invite(host, eventId, invited);

    expect(await attendanceOnList(invited, eventId)).toEqual<EventAttendanceWire>({
      attendeeId,
      status: EventParticipationStatus.Invited,
      role: SystemRole.EventParticipant,
      rsvpDate: null,
    });

    await rsvp(invited, eventId, attendeeId, EventParticipationStatus.Maybe);

    expect(await attendanceOnList(invited, eventId)).toEqual<EventAttendanceWire>({
      attendeeId,
      status: EventParticipationStatus.Maybe,
      role: SystemRole.EventParticipant,
      rsvpDate: null,
    });

    await rsvp(invited, eventId, attendeeId, EventParticipationStatus.Attending);

    expect(await attendanceOnList(invited, eventId)).toEqual<EventAttendanceWire>({
      attendeeId,
      status: EventParticipationStatus.Attending,
      role: SystemRole.EventParticipant,
      rsvpDate: expect.any(String),
    });
  });

  it('gives each attendee their own row of the same event, never the other one', async () => {
    const [host, invited] = await Promise.all([actors.user(), actors.user()]);
    const eventId = await createdEventId(host);
    const invitedRowId = await invite(host, eventId, invited);
    const hostRowId = await attendeeIdOf(host, eventId, host);

    const asHost = await attendanceOnList(host, eventId);
    const asInvited = await attendanceOnList(invited, eventId);

    expect(hostRowId).not.toBe(invitedRowId);
    expect(asHost?.attendeeId).toBe(hostRowId);
    expect(asInvited?.attendeeId).toBe(invitedRowId);
  });

  describe('GET /api/events/:id', () => {
    it("gives an attendee their row, and a friend who doesn't attend null", async () => {
      const [host, invited, friend] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await befriend(db.client, host, friend);
      const eventId = await createdEventId(host, { reach: Reach.Friends });
      const attendeeId = await invite(host, eventId, invited);

      expect((await readDetail(invited, eventId)).attendance).toEqual<EventAttendanceWire>({
        attendeeId,
        status: EventParticipationStatus.Invited,
        role: SystemRole.EventParticipant,
        rsvpDate: null,
      });

      expect((await readDetail(friend, eventId)).attendance).toBeNull();
    });

    // A removal keeps the row, so the read has to filter it out. Adding them
    // again clears `removedAt`, so the same row comes back (#551).
    it('gives a removed attendee of a Public event null, and their row again once re-added', async () => {
      const [host, attendee] = await Promise.all([actors.user(), actors.user()]);
      const eventId = await createdEventId(host, { reach: Reach.Public });
      const attendeeId = await invite(host, eventId, attendee);
      expect((await readDetail(attendee, eventId)).attendance?.attendeeId).toBe(attendeeId);

      await request(baseUrl)
        .delete(`${attendeesPath(eventId)}/${attendeeId}`)
        .set(host.headers)
        .expect(200);

      expect((await readDetail(attendee, eventId)).attendance).toBeNull();

      await invite(host, eventId, attendee);

      expect((await readDetail(attendee, eventId)).attendance?.attendeeId).toBe(attendeeId);
    });
  });

  // Its scope leaves out every event the acting user has a row on, so the read finds
  // nothing. The key stays, so the row is still a `GET /events` row.
  it('serves `attendance` as null on GET /api/events/browse', async () => {
    const [host, viewer] = await Promise.all([actors.user(), actors.user()]);
    const startDate = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const eventId = await createdEventId(host, { reach: Reach.Public, occurrences: [{ startDate }] });

    const row = await listedRow(viewer, BROWSE_PATH, eventId);

    expect(row).toHaveProperty('attendance', null);
  });

  /**
   * The ceiling is what keeps a key with no read on attendees from reading the
   * key owner's row, and a deny-all ceiling is enforced only by the real extension,
   * in a top-level `where` (#559). A key's grant keeps its action and type but
   * not the permission's conditions (#266), so the key is limited by type here.
   */
  describe('an API key', () => {
    const READ_EVENT = { slugs: ['read:event'], resourceType: ResourceType.Event };
    const READ_ATTENDEE = { slugs: ['read:event_attendee'], resourceType: ResourceType.EventAttendee };

    it('with no read on attendees lists the event with null attendance, where the key owner gets the row', async () => {
      const owner = await actors.user();
      const eventId = await createdEventId(owner);
      const key = await mintApiKey(baseUrl, db.client, owner, READ_EVENT);

      // The control: the key owner's session gets the row the key doesn't.
      expect((await attendanceOnList(owner, eventId))?.attendeeId).toBe(await attendeeIdOf(owner, eventId, owner));

      expect(await attendanceOnList(key, eventId)).toBeNull();
    });

    // The by-id read is a batch of its own, so it needs its own proof.
    it('with no read on attendees reads the event by id with null attendance, where the key owner gets the row', async () => {
      const owner = await actors.user();
      const eventId = await createdEventId(owner);
      const key = await mintApiKey(baseUrl, db.client, owner, READ_EVENT);

      expect((await readDetail(owner, eventId)).attendance?.attendeeId).toBe(await attendeeIdOf(owner, eventId, owner));

      expect((await readDetail(key, eventId)).attendance).toBeNull();
    });

    it('with a read on attendees gets the row', async () => {
      const owner = await actors.user();
      const eventId = await createdEventId(owner);
      const key = await mintApiKey(baseUrl, db.client, owner, [READ_EVENT, READ_ATTENDEE]);

      expect(await attendanceOnList(key, eventId)).toEqual<EventAttendanceWire>({
        attendeeId: await attendeeIdOf(owner, eventId, owner),
        status: EventParticipationStatus.Attending,
        role: SystemRole.EventHost,
        rsvpDate: null,
      });
    });
  });
});
