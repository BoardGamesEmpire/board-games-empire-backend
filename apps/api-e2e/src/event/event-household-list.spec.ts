import { EventSchedulingMode, Reach, ResourceType, SystemRole } from '@bge/database';
import {
  createActors,
  type Actors,
  type AuthenticatedActor,
  type HouseholdRosterEntry,
  type SessionActor,
} from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH, householdEventsPath } from './event-request';
import { listAttendeesEnvelope, listEventsEnvelope, type ListEventsEnvelope } from './event-wire';

/**
 * `GET /api/households/:householdId/events` over the real route (#506): a
 * household's upcoming events, limited by what the actor may read.
 *
 * Every household here is the test's own, so the assertions pin the whole page
 * and `total`.
 */
describe("a household's upcoming events (#506)", () => {
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

  /** One Confirmed date starting `start` hours from now, ending `end` hours from now if given. */
  const dated = (start: number, end?: number) => {
    const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

    return { occurrences: [{ startDate: soon(start), ...(end === undefined ? {} : { endDate: soon(end) }) }] };
  };

  const list = (caller: Caller, householdId: string) =>
    request(baseUrl).get(householdEventsPath(householdId)).query({ limit: 100 }).set(caller.headers);

  const page = async (caller: Caller, householdId: string): Promise<ListEventsEnvelope> =>
    listEventsEnvelope(await list(caller, householdId).expect(200), 'GET /api/households/:householdId/events');

  const idsOf = ({ events }: ListEventsEnvelope) => events.map(({ id }) => id);

  const householdOf = async (owner: SessionActor, ...members: HouseholdRosterEntry[]) =>
    (await actors.householdWithMembers({ owner, members })).household.id;

  const hostRowId = async (host: AuthenticatedActor, eventId: string) => {
    const { attendees } = listAttendeesEnvelope(
      await listAttendees(host, eventId, { limit: 100 }).expect(200),
      'GET /api/events/:eventId/attendees',
    );

    const row = attendees.find(({ userId }) => userId === host.user.id);

    // Throws rather than returning undefined: a host with null attendance would
    // otherwise compare equal to a row the list didn't serve.
    if (row === undefined) {
      throw new Error(`user ${host.user.id} has no attendee row on event ${eventId}`);
    }

    return row.id;
  };

  it("lists a member an event they don't attend, with null attendance, and the host their row", async () => {
    const [owner, member] = await Promise.all([actors.user(), actors.user()]);
    const householdId = await householdOf(owner, { actor: member, role: SystemRole.HouseholdMember });
    const eventId = await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2) });

    const asMember = await page(member, householdId);
    expect(idsOf(asMember)).toEqual([eventId]);
    expect(asMember.events[0]).toHaveProperty('attendance', null);

    const asHost = await page(owner, householdId);
    expect(idsOf(asHost)).toEqual([eventId]);
    expect(asHost.events[0].attendance?.attendeeId).toBe(await hostRowId(owner, eventId));
  });

  it("lists a household guest the household's Private event, and a stranger only its Public one", async () => {
    const [owner, guest, stranger] = await Promise.all([actors.user(), actors.user(), actors.user()]);
    const householdId = await householdOf(owner, { actor: guest, role: SystemRole.HouseholdGuest });
    const privateId = await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2) });
    const publicId = await createdEventId(owner, { householdId, reach: Reach.Public, ...dated(3) });

    expect(idsOf(await page(guest, householdId))).toEqual([privateId, publicId]);

    const asStranger = await page(stranger, householdId);
    expect(idsOf(asStranger)).toEqual([publicId]);
    expect(asStranger.total).toBe(1);
  });

  // A 403 for hidden rows would tell a stranger the household has events.
  it('answers a stranger an empty 200 for a household with only Private events', async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    const householdId = await householdOf(owner);
    await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2) });

    const asStranger = await page(stranger, householdId);

    expect(asStranger.events).toEqual([]);
    expect(asStranger.total).toBe(0);
  });

  it('leaves out a past event, a cancelled one, an archived one and one still choosing a date', async () => {
    const owner = await actors.user();
    const householdId = await householdOf(owner);
    const householdEvent = (body: Record<string, unknown> = {}) =>
      createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2), ...body });

    const upcomingId = await householdEvent();
    await householdEvent(dated(-3, -2));
    const cancelledId = await householdEvent();
    const archivedId = await householdEvent();
    await householdEvent({ schedulingMode: EventSchedulingMode.Poll });

    await request(baseUrl).post(`${EVENTS_PATH}/${cancelledId}/cancel`).set(owner.headers).send({}).expect(200);
    // No route archives an event with a date still ahead, so it is arranged
    // directly, and the archive alone keeps it out.
    await db.client.event.update({ where: { id: archivedId }, data: { archivedAt: new Date() } });

    const { events, total } = await page(owner, householdId);

    expect(events.map(({ id }) => id)).toEqual([upcomingId]);
    expect(total).toBe(1);
  });

  it("serves this household's events only, soonest first, and counts only those", async () => {
    const owner = await actors.user();
    const [householdId, otherHouseholdId] = [await householdOf(owner), await householdOf(owner)];
    const laterId = await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(5) });
    const soonerId = await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2) });
    await createdEventId(owner, { householdId: otherHouseholdId, reach: Reach.Private, ...dated(1) });

    const { events, total } = await page(owner, householdId);

    expect(events.map(({ id }) => id)).toEqual([soonerId, laterId]);
    expect(total).toBe(2);
  });

  // An Admin's ceiling admits every event, so only the scope can keep the list
  // to this household.
  it("serves an Admin this household's events, not every event on the server", async () => {
    const [owner, admin] = await Promise.all([actors.user(), actors.admin()]);
    const [householdId, otherHouseholdId] = [await householdOf(owner), await householdOf(owner)];
    const eventId = await createdEventId(owner, { householdId, reach: Reach.Private, ...dated(2) });
    await createdEventId(owner, { householdId: otherHouseholdId, reach: Reach.Private, ...dated(1) });

    const asAdmin = await page(admin, householdId);

    expect(idsOf(asAdmin)).toEqual([eventId]);
    expect(asAdmin.total).toBe(1);
  });

  it('answers 404 for a household that does not exist', async () => {
    const user = await actors.user();

    await list(user, randomUUID()).expect(404);
  });

  /**
   * The liveness guard answers a session 404, and passes a key that can't read
   * `Household`. A soft delete leaves the household's events live (#992), so
   * only the scope's own check on the household keeps them off this list.
   */
  it('answers the household owner 404 for a deleted household, and a key the guard passes an empty page', async () => {
    const owner = await actors.user();
    const householdId = await householdOf(owner);
    const eventId = await createdEventId(owner, { householdId, reach: Reach.Public, ...dated(2) });
    const key = await mintApiKey(baseUrl, db.client, owner, {
      slugs: ['read:event'],
      resourceType: ResourceType.Event,
    });

    // The control: the key lists the event while the household is live. It holds
    // no read on attendees, so it doesn't get the attendance its owner's session
    // would (#867).
    const whileLive = await page(key, householdId);
    expect(idsOf(whileLive)).toEqual([eventId]);
    expect(whileLive.events[0]).toHaveProperty('attendance', null);

    await request(baseUrl).delete(`/api/households/${householdId}`).set(owner.headers).expect(200);

    await list(owner, householdId).expect(404);

    const asKey = await page(key, householdId);
    expect(asKey.events).toEqual([]);
    expect(asKey.total).toBe(0);

    // The event itself stays live and readable by id, which is #992's to decide.
    await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(key.headers).expect(200);
  });
});
