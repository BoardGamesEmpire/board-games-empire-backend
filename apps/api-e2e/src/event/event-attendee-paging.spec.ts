import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { attendeesPath, createEventClient, EVENTS_PATH } from './event-request';
import { attendeeEnvelope, eventDetailEnvelope, listAttendeesEnvelope } from './event-wire';

/**
 * Paging an event's attendees, over the real routes (#373).
 *
 * The list used to return every attendee of the event, however many there
 * were. It now serves one page in the shared envelope, `total` included, in
 * the order the event detail embeds them: the order they were first added,
 * then id.
 */
describe('GET /api/events/:eventId/attendees pages (#373)', () => {
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

  const listedPage = async (host: AuthenticatedActor, eventId: string, query: { page?: number; limit?: number }) =>
    listAttendeesEnvelope(
      await listAttendees(host, eventId, query).expect(200),
      'GET /api/events/:eventId/attendees as the host',
    );

  /** An attendee with no user, recorded by name and email, added by `host`. */
  const attendeeAddedByName = async (host: AuthenticatedActor, eventId: string) =>
    attendeeEnvelope(
      await request(baseUrl)
        .post(attendeesPath(eventId))
        .set(host.headers)
        .send({
          guestName: 'Recorded by name',
          guestEmail: `e2e-attendee-${randomUUID().slice(0, 8)}@example.com`,
        })
        .expect(201),
      'POST /api/events/:eventId/attendees as the host',
    ).id;

  // The create adds the host and the users it invites in one write, so they
  // share a `createdAt`; only the id then keeps a row on the same page between
  // requests. The tie is asserted, so the test cannot go on passing without
  // one. A page past the end is an empty page with the true total, not a 404.
  it("pages attendees who joined in the same write once each, in the event detail's order", async () => {
    const host = await actors.user();
    const first = await actors.user();
    const second = await actors.user();
    const eventId = await createdEventId(host, { inviteUserIds: [first.user.id, second.user.id] });

    const pages = [];
    for (const page of [1, 2, 3, 4]) {
      pages.push(await listedPage(host, eventId, { page, limit: 1 }));
    }

    expect(pages.map(({ total }) => total)).toEqual([3, 3, 3, 3]);
    expect(pages.map(({ attendees }) => attendees.length)).toEqual([1, 1, 1, 0]);

    const paged = pages.flatMap(({ attendees }) => attendees.map(({ id }) => id));
    const detail = eventDetailEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200),
      'GET /api/events/:id as the host',
    );

    expect(new Set(detail.attendees.map(({ createdAt }) => createdAt)).size).toBe(1);
    expect(new Set(paged).size).toBe(3);
    expect(paged).toEqual(detail.attendees.map(({ id }) => id));
  });

  // A host's removal keeps the row, marked removed (#551). The count runs
  // through the same where as the rows, so `totalPages` never promises a page
  // that comes back short.
  it('leaves a removed attendee out of the rows and the total', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const removedId = await attendeeAddedByName(host, eventId);
    const keptId = await attendeeAddedByName(host, eventId);

    await request(baseUrl)
      .delete(`${attendeesPath(eventId)}/${removedId}`)
      .set(host.headers)
      .expect(200);

    const { attendees, total } = await listedPage(host, eventId, { limit: 10 });
    const ids = attendees.map(({ id }) => id);

    expect(total).toBe(2);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(removedId);
  });

  // The route binds the shared paging query (#373), so its bounds are every
  // list's: a value out of range is refused, never clamped to the nearest one.
  it('refuses a limit above 100 and a page below 1', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    // Control: the largest page the contract allows.
    await listAttendees(host, eventId, { limit: 100 }).expect(200);

    await listAttendees(host, eventId, { limit: 101 }).expect(400);
    await listAttendees(host, eventId, { page: 0 }).expect(400);
  });

  // The page size is the bound DTO's. Only the route can show which DTO that
  // is: every unit test passes its own limit.
  it('serves 25 attendees a page when no limit is sent', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    const { body } = await listAttendees(host, eventId).expect(200);

    expect(body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 25 }));
  });

  // Without the probe, the composed where would answer a missing event with an
  // empty page, and a deleted one with the attendee rows a soft delete keeps.
  it('answers 404 with paging parameters for an event that is missing or deleted', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    // Control: the same read is served while the event stands.
    await listAttendees(host, eventId, { limit: 10 }).expect(200);

    await listAttendees(host, randomUUID(), { limit: 10 }).expect(404);

    await db.client.event.update({ where: { id: eventId }, data: { deletedAt: new Date() } });
    await listAttendees(host, eventId, { limit: 10 }).expect(404);
  });
});
