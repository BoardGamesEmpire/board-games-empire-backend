import { GameMedium, Reach } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangePlatformGame } from '../list/list-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeCollectionEntry } from './game-collection-fixtures';
import { listRatingsEnvelope, readCollectionEnvelope } from './game-collection-wire';

/**
 * The history of a collection entry's rating, over the real routes (#1231).
 *
 * Each change of an entry's rating, and clearing it, is kept as a change dated
 * today, whether it comes from `POST /game-collections` or from `PATCH`. The
 * owner reads the history at `/game-collections/:id/ratings`, oldest first,
 * and no one else does, whatever the entry's reach.
 */
describe('collection rating history (#1231)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const COLLECTIONS_PATH = '/api/game-collections';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listRatings = (caller: SessionActor, entryId: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}/ratings`).set(caller.headers);

  const patchEntry = (caller: SessionActor, entryId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${COLLECTIONS_PATH}/${entryId}`).set(caller.headers).send(body);

  const addEntry = async (caller: SessionActor, platformGameId: string, body: Record<string, unknown>) =>
    readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(caller.headers)
        .send({ platformGameId, medium: GameMedium.Physical, ...body })
        .expect(201),
      'POST /api/game-collections as the owner',
    ).collection;

  /** The history as its owner reads it: each change's rating and date. */
  const historyOf = async (owner: SessionActor, entryId: string) =>
    listRatingsEnvelope(
      await listRatings(owner, entryId).expect(200),
      'GET /api/game-collections/:id/ratings as the owner',
    ).map(({ occurredOn, rating }) => ({ occurredOn, rating }));

  /** The entry as its owner reads it: its current rating is the one the history never rewrites. */
  const readEntry = async (owner: SessionActor, entryId: string) =>
    readCollectionEnvelope(
      await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(owner.headers).expect(200),
      'GET /api/game-collections/:id as the owner',
    ).collection;

  /** Today's UTC date: the server's zone never decides it, and neither does the test's. */
  const utcToday = () => new Date().toISOString().slice(0, 10);

  it('the owner reads the rating history oldest first, the backfilled unknown-date change first', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const firstDay = utcToday();

    await patchEntry(owner, entryId, { rating: 8 }).expect(200);
    await patchEntry(owner, entryId, { rating: null }).expect(200);
    // The migration's backfill gives an entry that already had a rating one
    // change with no known date. Written last here, so only the date, not the
    // order the changes were recorded in, puts it first.
    await db.client.collectionRatingChange.create({ data: { entryId, occurredOn: null, rating: 6 } });
    const lastDay = utcToday();

    const history = listRatingsEnvelope(
      await listRatings(owner, entryId).expect(200),
      'GET /api/game-collections/:id/ratings as the owner',
    );

    expect(history.map(({ rating }) => rating)).toEqual([6, 8, null]);
    expect(history[0]?.occurredOn).toBeNull();
    // Both changes made through the route are dated today, in UTC.
    expect([firstDay, lastDay]).toContain(history[1]?.occurredOn);
    expect([firstDay, lastDay]).toContain(history[2]?.occurredOn);
    expect(history[1]?.createdAt).toEqual(expect.any(String));
  });

  it('keeps one change for each change of the rating, and none for a write that repeats it', async () => {
    const owner = await actors.user();
    const { platformGameId } = await arrangePlatformGame(db.client);
    const { id: entryId } = await addEntry(owner, platformGameId, { rating: 7 });
    const day = utcToday();

    expect(await historyOf(owner, entryId)).toEqual([{ occurredOn: day, rating: 7 }]);

    // A replayed add, and a PATCH that sends the same rating, change nothing.
    await addEntry(owner, platformGameId, { rating: 7 });
    await patchEntry(owner, entryId, { rating: 7, comment: 'Still good' }).expect(200);
    await patchEntry(owner, entryId, { comment: 'No rating sent' }).expect(200);
    expect(await historyOf(owner, entryId)).toHaveLength(1);

    // A new rating from the add, and from a PATCH, each append one.
    await addEntry(owner, platformGameId, { rating: 9 });
    await patchEntry(owner, entryId, { rating: 4 }).expect(200);
    await patchEntry(owner, entryId, { rating: null }).expect(200);
    await patchEntry(owner, entryId, { rating: null }).expect(200);

    expect((await historyOf(owner, entryId)).map(({ rating }) => rating)).toEqual([7, 9, 4, null]);
    expect((await readEntry(owner, entryId)).rating).toBeNull();
  });

  it("another user's rating history answers COLLECTION_ENTRY_NOT_FOUND", async () => {
    const owner = await actors.user();
    const stranger = await actors.user();
    // Public, so the stranger may read the entry itself: its history is still the owner's alone.
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Public);
    await patchEntry(owner, entryId, { rating: 8 }).expect(200);

    await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(stranger.headers).expect(200);

    expectErrorEnvelope(await listRatings(stranger, entryId), { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
    // The control: the owner reads it.
    expect(await historyOf(owner, entryId)).toEqual([{ occurredOn: expect.any(String), rating: 8 }]);
  });

  // The Owner role may read every entry, but a rating history is its entry
  // owner's alone: the route reads the entry as the actor's own (#1231).
  it("the Owner role reading another user's rating history answers COLLECTION_ENTRY_NOT_FOUND", async () => {
    const entryOwner = await actors.user();
    const serverOwner = await actors.owner();
    const entryId = await arrangeCollectionEntry(db.client, entryOwner.user.id, Reach.Private);
    await patchEntry(entryOwner, entryId, { rating: 8 }).expect(200);

    expectErrorEnvelope(await listRatings(serverOwner, entryId), { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
  });
});
