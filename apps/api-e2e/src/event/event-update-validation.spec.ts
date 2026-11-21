import { EventSchedulingMode, EventType } from '@bge/database';
import type { Actors, AuthenticatedActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { createEventClient, EVENTS_PATH } from './event-request';
import { occurrenceEnvelope } from './event-wire';

/**
 * What an event's fields accept over the real routes (#1404).
 *
 * `UpdateEventDto` inherited `title`, `type` and `schedulingMode` through
 * `PartialType`, whose `IsOptional` skips `null`, so a `null` for one of these
 * non-nullable columns passed the pipe and answered 500 at the database.
 * `CreateEventDto`'s own `IsOptional` did the same for `type` and
 * `schedulingMode` on create. A blank title passed on create and update alike. The nullable columns still
 * clear with `null`.
 *
 * The same `IsOptional` let `null` through for the create's invite list and
 * its policy's non-nullable fields, and for a date's `sortOrder` on edit
 * (#1275).
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

  // Create's IsOptional skipped null too, so these reached the non-nullable
  // columns as a 500 (#1404).
  it.each([[{ type: null }], [{ schedulingMode: null }]])('POST answers 400 to %p', async (body) => {
    const host = await actors.user();

    expectErrorEnvelope(await createEvent(host, body), { status: 400, code: null });
  });

  // A left-out field must still take its column's default: ValidateIf skips
  // only a missing key (#1404, #1275).
  it('POST without type or schedulingMode stores their defaults (#1275)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    expect(await storedEvent(eventId)).toMatchObject({
      type: EventType.CasualGathering,
      schedulingMode: EventSchedulingMode.Fixed,
    });
  });

  // The service read a null invite list as a list, a TypeError and a 500
  // (#1275).
  it('POST answers 400 to a null inviteUserIds and creates nothing (#1275)', async () => {
    const host = await actors.user();
    const title = `e2e null invites ${host.user.id}`;

    expectErrorEnvelope(await createEvent(host, { title, inviteUserIds: null }), { status: 400, code: null });

    expect(await db.client.event.count({ where: { title } })).toBe(0);
  });

  it.each([
    'allowMemberInvites',
    'allowGuestInvites',
    'requireHostApprovalToJoin',
    'allowSpectators',
    'strictCapacity',
    'restrictToAttendeePool',
    'restrictToGameCategories',
    'gameAdditionMode',
    'voteThresholdType',
    'voteQuorumType',
    'voteEligibility',
    'interestedWeight',
  ])('POST answers 400 to null for policy.%s and creates nothing (#1275)', async (field) => {
    const host = await actors.user();
    const title = `e2e null ${field} ${host.user.id}`;

    expectErrorEnvelope(await createEvent(host, { title, policy: { [field]: null } }), { status: 400, code: null });

    expect(await db.client.event.count({ where: { title } })).toBe(0);
  });

  // PartialType's IsOptional let null through to a date's non-nullable
  // sortOrder as a 500 (#1275).
  it('PATCH a date with sortOrder null answers 400 and leaves the date as it was (#1275)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrencesPath = `${EVENTS_PATH}/${eventId}/occurrences`;
    const added = occurrenceEnvelope(
      await request(baseUrl)
        .post(occurrencesPath)
        .set(host.headers)
        .send({ label: 'Saturday', sortOrder: 2 })
        .expect(201),
      'POST /api/events/:eventId/occurrences',
    );

    expectErrorEnvelope(
      await request(baseUrl).patch(`${occurrencesPath}/${added.id}`).set(host.headers).send({ sortOrder: null }),
      { status: 400, code: null },
    );

    expect(await db.client.eventOccurrence.findUniqueOrThrow({ where: { id: added.id } })).toMatchObject({
      sortOrder: 2,
    });
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
