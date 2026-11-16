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
  listNominationsEnvelope,
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
   * Several dates take MultiDay mode, since a Fixed event holds one. `body`
   * is merged into the create request, such as a `policy`.
   */
  const createdWithDates = async (
    host: AuthenticatedActor,
    labels: readonly string[],
    body: Record<string, unknown> = {},
  ) => {
    const created = eventReplayEnvelope(
      await createEvent(host, {
        ...(labels.length > 1 ? { schedulingMode: EventSchedulingMode.MultiDay } : {}),
        occurrences: labels.map((label) => ({ label })),
        ...body,
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

  /**
   * The host's nomination of a game they offer, for the event or the date
   * named, and the entry it comes from. Under Direct mode its game joins the
   * lineup as it is made.
   */
  const nominated = async (host: AuthenticatedActor, eventId: string, occurrenceId?: string) => {
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);
    const nomination = nominationEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations`)
        .set(host.headers)
        .send({ platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById, occurrenceId })
        .expect(201),
      'POST /api/events/:eventId/nominations as the host',
    );

    return { entry, nomination };
  };

  const readNomination = async (actor: Caller, eventId: string, nominationId: string) =>
    nominationEnvelope(
      await request(baseUrl)
        .get(`${EVENTS_PATH}/${eventId}/nominations/${nominationId}`)
        .set(actor.headers)
        .expect(200),
      'GET /api/events/:eventId/nominations/:nominationId',
    );

  const listNominations = async (actor: Caller, eventId: string) =>
    listNominationsEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}/nominations`).set(actor.headers).expect(200),
      'GET /api/events/:eventId/nominations',
    );

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

  // The write answers the link as the read serves it: the lineup game is read
  // once the nomination's transaction has committed. It names its attendees
  // too, as every read and write answer does (#1213).
  it('links a passed nomination to its lineup game, both ways (#799)', async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday'], { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const { nomination: written } = await nominated(host, eventId, dateId);
    const {
      lineup: [lineupGame],
      total,
    } = await lineupOf(host, eventId);
    const read = await readNomination(host, eventId, written.id);

    expect(total).toBe(1);
    expect(lineupGame.nominationId).toBe(written.id);
    expect(written.elevatedTo).toEqual({ id: lineupGame.id, occurrenceId: dateId });
    expect(read.elevatedTo).toEqual({ id: lineupGame.id, occurrenceId: dateId });
    expect(written.nominatedBy?.id).toBe(hostAttendee.id);
    expect(written.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
  });

  // The list and the single read serve a nomination through the same reads,
  // so the two agree (#1213). Its game card names the game's subtitle, on the
  // nomination and on the entry that supplies it (#1271).
  it('serves a nomination alike in the list and the single read, its attendees named and its subtitle on both games (#1213, #1271)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const {
      entry,
      nomination: { id: nominationId },
    } = await nominated(host, eventId);
    // The fixture's game has no subtitle; the card must carry one when it has.
    const { gameId } = await db.client.platformGame.findUniqueOrThrow({
      where: { id: entry.platformGameId },
      select: { gameId: true },
    });
    await db.client.game.update({ where: { id: gameId }, data: { subtitle: 'The Card Game' } });
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });

    const listed = await listNominations(host, eventId);
    const read = await readNomination(host, eventId, nominationId);

    expect(listed.total).toBe(1);
    expect(listed.nominations).toEqual([read]);
    expect(read.nominatedBy?.id).toBe(hostAttendee.id);
    expect(read.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
    expect(read.platformGame.game.subtitle).toBe('The Card Game');
    expect(read.suppliedFrom.collection.platformGame.game.subtitle).toBe('The Card Game');
  });

  // The key's owner, the host, reads both attendees and the lineup; the key
  // holds read on nominations alone, so it gets neither, and keeps the ids.
  it('serves both attendees null, ids kept, to an API key that reads nominations but not attendees (#1213)', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host, { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const {
      entry,
      nomination: { id: nominationId },
    } = await nominated(host, eventId);
    const hostAttendee = await db.client.eventAttendee.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId: host.user.id } },
      select: { id: true },
    });
    const key = await mintApiKey(baseUrl, db.client, host, {
      slugs: ['read:event_game_nomination'],
      resourceType: ResourceType.EventGameNomination,
    });
    // The control: the host is named twice, and the game is in the lineup.
    const asHost = await readNomination(host, eventId, nominationId);
    expect(asHost.nominatedBy?.id).toBe(hostAttendee.id);
    expect(asHost.suppliedFrom.attendee?.id).toBe(hostAttendee.id);
    expect(asHost.elevatedTo).not.toBeNull();

    const asKey = await readNomination(key, eventId, nominationId);

    expect(asKey.nominatedById).toBe(hostAttendee.id);
    expect(asKey.nominatedBy).toBeNull();
    expect(asKey.suppliedFrom).toEqual(
      expect.objectContaining({ id: entry.suppliedById, attendeeId: hostAttendee.id, attendee: null }),
    );
    // Nor does it read the lineup (#799).
    expect(asKey.elevatedTo).toBeNull();
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

  // The same rule on the nominations' side: a nomination's lineup game is
  // read with its date under the date's own ceiling, so the link serves this
  // key no game the lineup read withholds from it.
  it("serves elevatedTo for the event's own lineup game and null for a date's to an API key that reads nominations and the lineup but no date (#799)", async () => {
    const host = await actors.user();
    const {
      eventId,
      dateIds: [dateId],
    } = await createdWithDates(host, ['Saturday'], { policy: { gameAdditionMode: GameAdditionMode.Direct } });
    const { nomination: ofEvent } = await nominated(host, eventId);
    const { nomination: ofDate } = await nominated(host, eventId, dateId);
    const key = await mintApiKey(baseUrl, db.client, host, [
      { slugs: ['read:event_game'], resourceType: ResourceType.EventGame },
      { slugs: ['read:event_game_nomination'], resourceType: ResourceType.EventGameNomination },
    ]);

    // The control: the key's owner reads both links.
    const eventsLink = (await readNomination(host, eventId, ofEvent.id)).elevatedTo;
    expect(eventsLink).toEqual({ id: expect.any(String), occurrenceId: null });
    expect((await readNomination(host, eventId, ofDate.id)).elevatedTo).toEqual({
      id: expect.any(String),
      occurrenceId: dateId,
    });

    expect((await readNomination(key, eventId, ofEvent.id)).elevatedTo).toEqual(eventsLink);
    expect((await readNomination(key, eventId, ofDate.id)).elevatedTo).toBeNull();
  });
});
