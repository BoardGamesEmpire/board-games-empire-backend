import { EventParticipationStatus, InviteStatus, Reach } from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { befriend, createActors } from '@bge/testing-e2e';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventInviteClient, inviteAndAccept } from './event-join';
import { attendeesPath, BROWSE_PATH, createEventClient, EVENTS_PATH } from './event-request';
import { eventDetailEnvelope, listEventsEnvelope } from './event-wire';

/**
 * A deleted household's events read and write as gone (#992). A household
 * delete stamps only the household, so each event's own row stays as it was;
 * the shared liveness clause hides it, for everyone, staff included, and a
 * restore brings it back.
 *
 * Every refusal is the 404 a deleted event gives. Each case that expects one
 * after a delete reaches the event while the household is live first, so a
 * test that lost the event some other way fails at that control.
 *
 * Browse is checked for this test's events only, never the whole page: every
 * page asks for 100 rows and the dates fall within the next hour, so this
 * test's events land on the first page.
 */
describe("a deleted household's events (#992)", () => {
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

  /** One Confirmed date starting within the hour. */
  const dated = () => ({ occurrences: [{ startDate: new Date(Date.now() + 1_800_000).toISOString() }] });

  const readEvent = (caller: Caller, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(caller.headers);

  const browse = async (caller: Caller) =>
    listEventsEnvelope(
      await request(baseUrl).get(`${BROWSE_PATH}?limit=100`).set(caller.headers).expect(200),
      'GET /api/events/browse',
    ).events.map(({ id }) => id);

  const ownEvents = async (caller: Caller) =>
    listEventsEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}?limit=100`).set(caller.headers).expect(200),
      'GET /api/events',
    ).events.map(({ id }) => id);

  const deleteHousehold = (owner: SessionActor, householdId: string) =>
    request(baseUrl).delete(`/api/households/${householdId}`).set(owner.headers).expect(200);

  const restoreHousehold = (owner: SessionActor, householdId: string) =>
    request(baseUrl).post(`/api/households/${householdId}/restore`).set(owner.headers).expect(200);

  /** A household `owner` alone belongs to, and an event in it at `reach` (Public by default) with a date ahead. */
  const householdEvent = async (owner: SessionActor, reach: Reach = Reach.Public) => {
    const { household } = await actors.householdWithMembers({ owner, members: [] });
    const eventId = await createdEventId(owner, { householdId: household.id, reach, ...dated() });

    return { householdId: household.id, eventId };
  };

  const { invite } = createEventInviteClient(baseUrl);

  const hostAttendeeId = async (host: AuthenticatedActor, eventId: string) => {
    const row = await db.client.eventAttendee.findFirstOrThrow({
      where: { eventId, userId: host.user.id },
      select: { id: true },
    });

    return row.id;
  };

  it('hides a Public event from a signed-in stranger, by id and on browse, until a restore', async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    const { householdId, eventId } = await householdEvent(owner);

    await readEvent(stranger, eventId).expect(200);
    expect(await browse(stranger)).toContain(eventId);

    await deleteHousehold(owner, householdId);

    await readEvent(stranger, eventId).expect(404);
    expect(await browse(stranger)).not.toContain(eventId);

    await restoreHousehold(owner, householdId);

    await readEvent(stranger, eventId).expect(200);
    expect(await browse(stranger)).toContain(eventId);
  });

  // An attendee row survives the household delete, so without the liveness
  // clause the attendee's own list and every sub-resource read would still
  // reach the event.
  it('hides it from an attendee who is not a member: their GET /events list and its sub-resources', async () => {
    const [owner, friend] = await Promise.all([actors.user(), actors.user()]);
    await befriend(db.client, owner, friend);
    const { householdId, eventId } = await householdEvent(owner);
    await inviteAndAccept(baseUrl, owner, friend, eventId);

    const subResources = [
      `${EVENTS_PATH}/${eventId}/occurrences`,
      attendeesPath(eventId),
      `${EVENTS_PATH}/${eventId}/nominations`,
    ];

    expect(await ownEvents(friend)).toContain(eventId);
    for (const path of subResources) {
      await request(baseUrl).get(path).set(friend.headers).expect(200);
    }

    await deleteHousehold(owner, householdId);

    expect(await ownEvents(friend)).not.toContain(eventId);
    for (const path of subResources) {
      await request(baseUrl).get(path).set(friend.headers).expect(404);
    }

    await restoreHousehold(owner, householdId);

    expect(await ownEvents(friend)).toContain(eventId);
    await listAttendees(friend, eventId).expect(200);
  });

  it("refuses the host's edit and a new invite while the household is deleted", async () => {
    const [owner, friend] = await Promise.all([actors.user(), actors.user()]);
    await befriend(db.client, owner, friend);
    const { householdId, eventId } = await householdEvent(owner);

    await request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(owner.headers).send({ title: 'Live' }).expect(200);

    await deleteHousehold(owner, householdId);

    await request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(owner.headers).send({ title: 'Gone' }).expect(404);
    await invite(owner, eventId, { userId: friend.user.id }).expect(404);

    expect(await db.client.invite.count({ where: { eventId } })).toBe(0);
    expect(await db.client.eventAttendee.count({ where: { eventId, userId: friend.user.id } })).toBe(0);

    // The refused edit left the title as it was.
    await restoreHousehold(owner, householdId);
    const event = eventDetailEnvelope(await readEvent(owner, eventId).expect(200), 'GET /api/events/:id');
    expect(event.title).toBe('Live');
  });

  // The household's events go with it, so the delete revokes their open
  // invites as an event's own delete does, rather than leaving them for the
  // sweep to call expired (#742). A restore leaves them revoked, as it leaves
  // the household's own.
  it('revokes the open invites to its events, leaves an event outside it alone, and a restore keeps them revoked', async () => {
    const [owner, friend] = await Promise.all([actors.user(), actors.user()]);
    await befriend(db.client, owner, friend);
    const { householdId, eventId } = await householdEvent(owner);
    const loneId = await createdEventId(owner, { reach: Reach.Public, ...dated() });
    const { sentInvite, accept } = createEventInviteClient(baseUrl);
    const toTheEvent = await sentInvite(owner, eventId, { userId: friend.user.id });
    const toTheLoneEvent = await sentInvite(owner, loneId, { userId: friend.user.id });

    await deleteHousehold(owner, householdId);

    const statusOf = async (id: string) =>
      (await db.client.invite.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await statusOf(toTheEvent.id)).toBe(InviteStatus.Revoked);
    expect(await statusOf(toTheLoneEvent.id)).toBe(InviteStatus.Pending);

    await restoreHousehold(owner, householdId);

    expect(await statusOf(toTheEvent.id)).toBe(InviteStatus.Revoked);
    expectErrorEnvelope(await accept(friend, toTheEvent.id), { status: 409, code: 'INVITE_NOT_OUTSTANDING' });
  });

  // Staff read every event, so this pins that the clause isn't a catalog
  // condition a wider grant could bypass.
  it('answers staff 404 too', async () => {
    const [owner, admin] = await Promise.all([actors.user(), actors.admin()]);
    const { householdId, eventId } = await householdEvent(owner);

    await readEvent(admin, eventId).expect(200);

    await deleteHousehold(owner, householdId);

    await readEvent(admin, eventId).expect(404);
  });

  // The household relation is optional; a bare household filter would drop
  // every event outside a household.
  it('leaves an event outside any household alone', async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    const { householdId } = await householdEvent(owner);
    const loneId = await createdEventId(owner, { reach: Reach.Public, ...dated() });

    await deleteHousehold(owner, householdId);

    await readEvent(owner, loneId).expect(200);
    await readEvent(stranger, loneId).expect(200);
    expect(await browse(stranger)).toContain(loneId);
    await request(baseUrl)
      .patch(`${attendeesPath(loneId)}/${await hostAttendeeId(owner, loneId)}/status`)
      .set(owner.headers)
      .send({ status: EventParticipationStatus.Maybe })
      .expect(200);
  });

  // The liveness clause sits beside the read ceiling, and its `OR` must not
  // loosen it: an actor whose ceiling doesn't reach the event still finds
  // nothing.
  it('still refuses a stranger a Private event in a live household', async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    const { eventId } = await householdEvent(owner, Reach.Private);

    await readEvent(owner, eventId).expect(200);
    await readEvent(stranger, eventId).expect(404);
    expect(await browse(stranger)).not.toContain(eventId);
  });
});
