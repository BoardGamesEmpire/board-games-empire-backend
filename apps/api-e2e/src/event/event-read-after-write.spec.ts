import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';
import { attendeeEnvelope, eventEnvelope, listEventsEnvelope } from './event-wire';

/**
 * Event reads that follow a write to what they read, and must reflect it
 * (#530).
 *
 * The api response-caches a GET only when its route opts in, per caller, for
 * `CACHE_TTL`. Until #530 every GET was cached unless its route opted out, and
 * the event routes never did. A cached read repeats the body it returned
 * before the write, and the removal case is worse than stale: the list's
 * guard checks the type alone, and the row scoping that leaves the event out
 * lives in the service, which a cache hit never reaches.
 *
 * So each case reads FIRST, priming whatever cache is in front of the route,
 * and only then writes. Without that first read, both would pass with the
 * event routes cached.
 */
describe('event reads after a write', () => {
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

  const readEvent = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers);

  const listedIds = async (actor: AuthenticatedActor, description: string) =>
    listEventsEnvelope(await request(baseUrl).get(EVENTS_PATH).set(actor.headers).expect(200), description).events.map(
      (event) => event.id,
    );

  it('drops an event from the list of an attendee the host has just removed', async () => {
    const host = await actors.user();
    const invitee = await actors.user();
    const eventId = await createdEventId(host);

    const attendee = attendeeEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/attendees`)
        .set(host.headers)
        .send({ userId: invitee.user.id })
        .expect(201),
      'POST /api/events/:eventId/attendees as the host',
    );

    await expect(listedIds(invitee, 'GET /api/events before the removal')).resolves.toEqual([eventId]);

    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}/attendees/${attendee.id}`).set(host.headers).expect(200);

    await expect(listedIds(invitee, 'GET /api/events after the removal')).resolves.toEqual([]);
  });

  it('reads back an edit its caller has just made', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { title: 'Before the edit' });

    const before = eventEnvelope(await readEvent(host, eventId).expect(200), 'GET /api/events/:id before the edit');
    expect(before.title).toBe('Before the edit');

    await request(baseUrl)
      .patch(`${EVENTS_PATH}/${eventId}`)
      .set(host.headers)
      .send({ title: 'After the edit' })
      .expect(200);

    const after = eventEnvelope(await readEvent(host, eventId).expect(200), 'GET /api/events/:id after the edit');
    expect(after.title).toBe('After the edit');
  });
});
