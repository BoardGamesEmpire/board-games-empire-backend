import { EventSchedulingMode, GameAdditionMode, NominationStatus, ResourceType } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import {
  eventGameEnvelope,
  eventReplayEnvelope,
  listLineupEnvelope,
  nominationEnvelope,
  type ListLineupEnvelope,
} from './event-wire';

/**
 * An event's whole lineup in one paged read, over the real routes (#799): the
 * event's own games and the games of each date the actor can read.
 *
 * Every game is put in the lineup through its route; only the supplier's game,
 * and its place on their list for the event, are arranged in the database.
 * Which dates an actor reads is decided by the real CASL extension, in a
 * top-level `where` (#559), so the key that reads no date is proven here, not
 * in the unit specs.
 */
describe('GET /api/events/:eventId/lineup (#799)', () => {
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

  const lineupPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/lineup`;

  const listLineup = (actor: Caller, eventId: string, query: Record<string, string> = {}) =>
    request(baseUrl).get(lineupPath(eventId)).query(query).set(actor.headers);

  const lineupOf = async (
    actor: Caller,
    eventId: string,
    query: Record<string, string> = {},
  ): Promise<ListLineupEnvelope> =>
    listLineupEnvelope(
      await listLineup(actor, eventId, query).expect(200),
      `GET /api/events/:eventId/lineup ${JSON.stringify(query)}`,
    );

  /** Each row's id and date, the two facts the order and the narrowing turn on. */
  const placesOf = ({ lineup }: ListLineupEnvelope) => lineup.map(({ id, occurrenceId }) => ({ id, occurrenceId }));

  /**
   * The event `host` creates, with one date per label, and the dates' ids.
   * Several dates take MultiDay mode, since a Fixed event holds one.
   */
  const createdWithDates = async (host: AuthenticatedActor, labels: readonly string[]) => {
    const created = eventReplayEnvelope(
      await createEvent(host, {
        ...(labels.length > 1 ? { schedulingMode: EventSchedulingMode.MultiDay } : {}),
        occurrences: labels.map((label) => ({ label })),
      }).expect(201),
      'POST /api/events with dates',
    );

    return { eventId: created.id, dateIds: created.occurrences.map(({ id }) => id) };
  };

  /** Puts a game the host offers in the lineup: the event's own, or the date's when one is named. */
  const directAddedGameId = async (host: AuthenticatedActor, eventId: string, occurrenceId?: string) =>
    eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(host.headers)
        .send({ ...(await arrangeListEntry(db.client, eventId, host.user.id)), occurrenceId })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add as the host',
    ).id;

  // An event's own game has no date, and Postgres sorts a null last on an
  // ascending key, so the dates come first.
  it("reads the event's own lineup and each date's, the dates first (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday']);
    // Added first, so a read in the order the games were written puts it first.
    const eventsGame = await directAddedGameId(host, eventId);
    const datesGame = await directAddedGameId(host, eventId, dateId);
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const page = await lineupOf(host, eventId);

    expect(placesOf(page)).toEqual([
      { id: datesGame, occurrenceId: dateId },
      { id: eventsGame, occurrenceId: null },
    ]);
    expect(page.total).toBe(2);
    // The host reads their own attendee row, so each game names them as its supplier.
    expect(page.lineup.map(({ suppliedBy }) => suppliedBy.attendee?.id)).toEqual([hostAttendee.id, hostAttendee.id]);
  });

  it("reads a passed nomination's game in the event's own lineup (#799)", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);

    const nomination = nominationEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations`)
        .set(host.headers)
        .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById })
        .expect(201),
      'POST /api/events/:eventId/nominations under Direct mode',
    );
    // Direct mode passes a nomination as it is made, and puts its game in the lineup.
    expect(nomination.status).toBe(NominationStatus.Passed);

    const { lineup, total } = await lineupOf(host, eventId);

    expect(lineup).toEqual([
      expect.objectContaining({
        nominationId: nomination.id,
        occurrenceId: null,
        platformGameId: entry.platformGameId,
        suppliedBy: expect.objectContaining({ id: entry.suppliedById }),
      }),
    ]);
    expect(total).toBe(1);
  });

  it('narrows to one date with occurrenceId (#799)', async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [saturday, sunday],
    } = await createdWithDates(host, ['Saturday', 'Sunday']);
    await directAddedGameId(host, eventId);
    await directAddedGameId(host, eventId, saturday);
    const sundaysGame = await directAddedGameId(host, eventId, sunday);

    // The control: the whole lineup holds all three.
    expect((await lineupOf(host, eventId)).total).toBe(3);

    const narrowed = await lineupOf(host, eventId, { occurrenceId: sunday });

    expect(placesOf(narrowed)).toEqual([{ id: sundaysGame, occurrenceId: sunday }]);
    expect(narrowed.total).toBe(1);
  });

  it('answers 404 for a deleted event (#799)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    await directAddedGameId(host, eventId);

    // The control: the lineup is read before the delete.
    expect((await lineupOf(host, eventId)).total).toBe(1);

    await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200);

    await listLineup(host, eventId).expect(404);
  });

  // The `User` role holds no read on the lineup; an event's roles grant it.
  it('refuses a user outside the event (#799)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const outsider = await actors.user();

    // The control: the host reads the same event's lineup.
    await listLineup(host, eventId).expect(200);

    await listLineup(outsider, eventId).expect(403);
  });

  // The lineup's ceiling names a date's games through the date's event, so it
  // would serve this key the date's game: the read of the dates, under their
  // own ceiling, is what keeps it out. The key holds no read on attendees
  // either, so the supplier is not named.
  it("serves the event's own lineup alone to an API key that reads the lineup but no date (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday']);
    const eventsGame = await directAddedGameId(host, eventId);
    await directAddedGameId(host, eventId, dateId);
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:event_game'],
      resourceType: ResourceType.EventGame,
    });

    // The control: the key's owner reads both games.
    expect((await lineupOf(host, eventId)).total).toBe(2);

    const page = await lineupOf(key, eventId);

    expect(placesOf(page)).toEqual([{ id: eventsGame, occurrenceId: null }]);
    expect(page.total).toBe(1);
    expect(page.lineup[0].suppliedBy.attendee).toBeNull();
  });
});
