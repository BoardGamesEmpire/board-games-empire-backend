import { OccurrenceStatus, PlatformType, ScheduledGameRole } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, EVENTS_PATH } from './event-request';
import { eventGameEnvelope, listOccurrencesEnvelope, occurrenceEnvelope } from './event-wire';

/**
 * What the occurrence routes serve, over the real routes (#558).
 *
 * Until #558 every occurrence route that serves an occurrence answered 500.
 * The include they share still selected `EventGame` fields a schema change
 * had replaced, and Prisma refuses an invalid include before it sends any
 * SQL, so the routes failed whether or not the event had occurrences.
 * Typecheck missed it because the include was a module constant rather than
 * a fresh literal, and no e2e called the routes.
 *
 * Occurrences, and the game put on one, are written through their routes, so
 * every read below serves rows the API wrote. Only the supplier's game, and
 * its place on their list for the event, are arranged in the database. Each
 * test creates its own event, since an event in the default Fixed scheduling
 * mode holds one occurrence.
 */
describe('event occurrences', () => {
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

  const occurrencesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/occurrences`;

  const readOccurrence = (actor: AuthenticatedActor, eventId: string, occurrenceId: string) =>
    request(baseUrl)
      .get(`${occurrencesPath(eventId)}/${occurrenceId}`)
      .set(actor.headers);

  const listOccurrences = (actor: AuthenticatedActor, eventId: string) =>
    request(baseUrl).get(occurrencesPath(eventId)).set(actor.headers);

  const addedOccurrence = async (actor: AuthenticatedActor, eventId: string) =>
    occurrenceEnvelope(
      await request(baseUrl).post(occurrencesPath(eventId)).set(actor.headers).send({ label: 'Saturday' }).expect(201),
      'POST /api/events/:eventId/occurrences',
    );

  /** Puts a game from the host's list on the occurrence, under `sortOrder` when one is given. */
  const directAddedGameId = async (
    actor: AuthenticatedActor,
    eventId: string,
    occurrenceId: string,
    sortOrder?: number,
  ) =>
    eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(actor.headers)
        .send({ ...(await arrangeListEntry(db.client, eventId, actor.user.id)), occurrenceId, sortOrder })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add with a sort order',
    ).id;

  it('adds an occurrence, lists it, reads it and updates it', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);

    const added = await addedOccurrence(host, eventId);
    // Confirmed: the event is in the default Fixed scheduling mode.
    expect(added).toEqual(
      expect.objectContaining({ eventId, label: 'Saturday', status: OccurrenceStatus.Confirmed, games: [] }),
    );

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences',
    );
    expect(page.occurrences.map((occurrence) => occurrence.id)).toEqual([added.id]);
    expect(page.total).toBe(1);

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, added.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(read).toEqual(expect.objectContaining({ id: added.id, label: 'Saturday', games: [] }));

    const updated = occurrenceEnvelope(
      await request(baseUrl)
        .patch(`${occurrencesPath(eventId)}/${added.id}`)
        .set(host.headers)
        .send({ label: 'Saturday evening' })
        .expect(200),
      'PATCH /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(updated).toEqual(expect.objectContaining({ id: added.id, label: 'Saturday evening', games: [] }));
  });

  it('serves a game put on the occurrence with its platform game, game and platform', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);
    const entry = await arrangeListEntry(db.client, eventId, host.user.id);

    const eventGame = eventGameEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/nominations/direct-add`)
        .set(host.headers)
        .send({ ...entry, occurrenceId: occurrence.id })
        .expect(201),
      'POST /api/events/:eventId/nominations/direct-add with an occurrence',
    );
    expect(eventGame.occurrenceId).toBe(occurrence.id);

    // The game and platform as stored, for the ids and title the fixture
    // generated. The platform is the seeded tabletop one.
    const stored = await db.client.platformGame.findUniqueOrThrow({
      where: { id: entry.platformGameId },
      select: { gameId: true, platformId: true, game: { select: { title: true } } },
    });
    const expectedGames = [
      {
        id: eventGame.id,
        platformGameId: entry.platformGameId,
        role: ScheduledGameRole.Primary,
        platformGame: {
          id: entry.platformGameId,
          game: { id: stored.gameId, title: stored.game.title, thumbnail: null },
          platform: { id: stored.platformId, name: 'Tabletop', platformType: PlatformType.Tabletop },
        },
      },
    ];

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with a game',
    );
    expect(read.games).toEqual(expectedGames);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with a game',
    );
    expect(page.occurrences.map((listed) => listed.games)).toEqual([expectedGames]);
  });

  it("serves the occurrence's games in the order the host gave them", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    // Added in the reverse of their order, so a read that returns them as
    // they were written comes back wrong.
    const second = await directAddedGameId(host, eventId, occurrence.id, 1);
    const first = await directAddedGameId(host, eventId, occurrence.id, 0);

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with two games',
    );
    expect(read.games.map((game) => game.id)).toEqual([first, second]);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with two games',
    );
    expect(page.occurrences.map((listed) => listed.games.map((game) => game.id))).toEqual([[first, second]]);
  });

  it("breaks a tie in the host's order by the game's id", async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    // No game here is given a sort order, so each takes the default and they
    // all tie, as in any lineup the host leaves unnumbered. Ids are random, so
    // games added in turn may already be in id order, and a read returning
    // ties as they were written would pass. Adding stops once one sorts before
    // an earlier one; eight in id order by chance is 1 in 40,320.
    const inIdOrder = (ids: readonly string[]) => ids.every((id, index) => index === 0 || ids[index - 1] < id);
    const addedIds: string[] = [];
    do {
      addedIds.push(await directAddedGameId(host, eventId, occurrence.id));
    } while (inIdOrder(addedIds) && addedIds.length < 8);
    expect(inIdOrder(addedIds)).toBe(false);

    // The ids are lowercase letters and digits of one length, so the
    // database's order and a string sort agree.
    const byId = [...addedIds].sort();

    const read = occurrenceEnvelope(
      await readOccurrence(host, eventId, occurrence.id).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId with tied games',
    );
    expect(read.games.map((game) => game.id)).toEqual(byId);

    const page = listOccurrencesEnvelope(
      await listOccurrences(host, eventId).expect(200),
      'GET /api/events/:eventId/occurrences with tied games',
    );
    expect(page.occurrences.map((listed) => listed.games.map((game) => game.id))).toEqual([byId]);
  });

  it('cancels a confirmed occurrence, then deletes it', async () => {
    const host = await actors.user();
    const eventId = await createdEventId(host);
    const occurrence = await addedOccurrence(host, eventId);

    const cancelled = occurrenceEnvelope(
      await request(baseUrl)
        .post(`${occurrencesPath(eventId)}/${occurrence.id}/cancel`)
        .set(host.headers)
        .expect(201),
      'POST /api/events/:eventId/occurrences/:occurrenceId/cancel',
    );
    expect(cancelled).toEqual(
      expect.objectContaining({ id: occurrence.id, status: OccurrenceStatus.Cancelled, cancelledById: host.user.id }),
    );

    const removed = occurrenceEnvelope(
      await request(baseUrl)
        .delete(`${occurrencesPath(eventId)}/${occurrence.id}`)
        .set(host.headers)
        .expect(200),
      'DELETE /api/events/:eventId/occurrences/:occurrenceId',
    );
    expect(removed.id).toBe(occurrence.id);
    // Checked in the database: a read answering 404 would pass just as well
    // if the read scope left cancelled occurrences out.
    expect(await db.client.eventOccurrence.count({ where: { id: occurrence.id } })).toBe(0);
  });
});
