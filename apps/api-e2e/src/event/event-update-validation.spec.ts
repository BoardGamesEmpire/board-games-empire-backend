import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';

/**
 * What an event's fields accept over the real routes (#1404).
 *
 * `UpdateEventDto` inherited `title`, `type` and `schedulingMode` through
 * `PartialType`, whose `IsOptional` skips `null`, so a `null` for one of these
 * non-nullable columns passed the pipe and answered 500 at the database. A
 * blank title passed on create and update alike. The nullable columns still
 * clear with `null`.
 */
describe("an event's fields on create and update (#1404)", () => {
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

  const { createEvent, createdEventId } = createEventClient(baseUrl);

  const updateEvent = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(actor.headers).send(body);

  const storedEvent = (eventId: string) => db.client.event.findUniqueOrThrow({ where: { id: eventId } });

  it.each([[{ title: null }], [{ type: null }], [{ schedulingMode: null }], [{ title: '' }], [{ title: '   ' }]])(
    'PATCH answers 400 to %p and leaves the event as it was',
    async (body) => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const before = await storedEvent(eventId);

      expectErrorEnvelope(await updateEvent(host, eventId, body), { status: 400, code: null });

      expect(await storedEvent(eventId)).toEqual(before);
    },
  );

  it.each([[''], ['   ']])('POST answers 400 to the blank title %p', async (title) => {
    const host = await actors.user();

    expectErrorEnvelope(await createEvent(host, { title }), { status: 400, code: null });
  });

  it('PATCH clears description, image, location and url with null', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, {
      description: 'Bring snacks',
      image: 'cover.png',
      location: 'Kitchen table',
      url: 'https://example.com/game-night',
    });

    await updateEvent(host, eventId, { description: null, image: null, location: null, url: null }).expect(200);

    expect(await storedEvent(eventId)).toMatchObject({ description: null, image: null, location: null, url: null });
  });
});
