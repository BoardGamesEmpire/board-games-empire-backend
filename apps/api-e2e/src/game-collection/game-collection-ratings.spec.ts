import { GameMedium, Reach, syncMayWrite } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangePlatformGame } from '../list/list-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeCollectionEntry } from './game-collection-fixtures';
import {
  listRatingRevisionsEnvelope,
  listRatingsEnvelope,
  ratingChangeEnvelope,
  readCollectionEnvelope,
} from './game-collection-wire';

/**
 * The history of a collection entry's rating, over the real routes (#1231).
 *
 * Each change of an entry's rating, and clearing it, is kept as a change dated
 * today, whether it comes from `POST /game-collections` or from `PATCH`. The
 * owner reads the history at `/game-collections/:id/ratings`, oldest first,
 * and no one else does, whatever the entry's reach.
 *
 * The owner corrects it there too: adds an earlier rating, edits one, takes
 * one back and restores a revision. Correcting the history never changes the
 * entry's current rating, and every correction stamps the change as edited by
 * the user, so an upstream sync leaves it alone.
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
    // The control: the entry's owner reads the change.
    expect(await historyOf(entryOwner, entryId)).toEqual([{ occurredOn: expect.any(String), rating: 8 }]);
  });

  describe('corrections', () => {
    const ratingsPath = (entryId: string) => `${COLLECTIONS_PATH}/${entryId}/ratings`;
    const changePath = (entryId: string, ratingId: string) => `${ratingsPath(entryId)}/${ratingId}`;

    const addRating = (caller: SessionActor, entryId: string, body: Record<string, unknown>) =>
      request(baseUrl).post(ratingsPath(entryId)).set(caller.headers).send(body);

    const editRating = (caller: SessionActor, entryId: string, ratingId: string, body: Record<string, unknown>) =>
      request(baseUrl).patch(changePath(entryId, ratingId)).set(caller.headers).send(body);

    const takeBack = (caller: SessionActor, entryId: string, ratingId: string) =>
      request(baseUrl)
        .post(`${changePath(entryId, ratingId)}/retraction`)
        .set(caller.headers);

    const undoTakeBack = (caller: SessionActor, entryId: string, ratingId: string) =>
      request(baseUrl)
        .delete(`${changePath(entryId, ratingId)}/retraction`)
        .set(caller.headers);

    const listRevisions = (caller: SessionActor, entryId: string, ratingId: string) =>
      request(baseUrl)
        .get(`${changePath(entryId, ratingId)}/revisions`)
        .set(caller.headers);

    const restoreRevision = (caller: SessionActor, entryId: string, ratingId: string, revisionId: string) =>
      request(baseUrl)
        .post(`${changePath(entryId, ratingId)}/revisions/${revisionId}/restore`)
        .set(caller.headers);

    /** An earlier rating, added as the owner: the change as the owner reads it. */
    const added = async (owner: SessionActor, entryId: string, body: Record<string, unknown>) =>
      ratingChangeEnvelope(
        await addRating(owner, entryId, body).expect(201),
        'POST /api/game-collections/:id/ratings as the owner',
      );

    /** The owner's revisions of one change, newest first. */
    const revisionsOf = async (owner: SessionActor, entryId: string, ratingId: string) =>
      listRatingRevisionsEnvelope(
        await listRevisions(owner, entryId, ratingId).expect(200),
        'GET /api/game-collections/:id/ratings/:ratingId/revisions as the owner',
      );

    /** The history with each change's id, flag and date, as the owner reads it. */
    const fullHistory = async (owner: SessionActor, entryId: string) =>
      listRatingsEnvelope(
        await listRatings(owner, entryId).expect(200),
        'GET /api/game-collections/:id/ratings as the owner',
      );

    const editedByUserAt = async (ratingId: string) =>
      (await db.client.collectionRatingChange.findUniqueOrThrow({ where: { id: ratingId } })).editedByUserAt;

    /** An entry the owner has rated 6, with that change as the owner reads it. */
    const arrangeRatedEntry = async (owner: SessionActor, reach: Reach = Reach.Private) => {
      const entryId = await arrangeCollectionEntry(db.client, owner.user.id, reach);
      await patchEntry(owner, entryId, { rating: 6 }).expect(200);
      const [today] = await fullHistory(owner, entryId);
      if (today === undefined) {
        throw new Error('the rating written through the route left no change in the history');
      }

      return { entryId, today };
    };

    it("adding an earlier rating keeps the entry's current rating", async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      const earlier = await added(owner, entryId, { occurredOn: '2015-04', rating: 9 });

      expect(earlier).toMatchObject({ occurredOn: '2015-04', rating: 9, retractedAt: null });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
      // The earlier change sorts before today's, by its date.
      expect((await fullHistory(owner, entryId)).map(({ id }) => id)).toEqual([earlier.id, today.id]);
      expect(await editedByUserAt(earlier.id)).toEqual(expect.any(Date));
    });

    // ADR 0002: a client queues the add offline and may send it again.
    it('a replayed add of an earlier rating adds one change (#1231)', async () => {
      const owner = await actors.user();
      const { entryId } = await arrangeRatedEntry(owner);
      const body = { clientRequestId: 'queued-add-1', occurredOn: '2015-04', rating: 9 };

      const first = await added(owner, entryId, body);
      // The key's replay answers 201 again with the original, whatever its body says, a future date too.
      const replay = await added(owner, entryId, { ...body, occurredOn: '2999', rating: 2 });
      // Even after the change was taken back since.
      await takeBack(owner, entryId, first.id).expect(200);
      const afterTakeBack = await added(owner, entryId, body);

      expect(replay).toEqual(first);
      expect(afterTakeBack).toMatchObject({ id: first.id, rating: 9, retractedAt: expect.any(String) });
      expect(await fullHistory(owner, entryId)).toHaveLength(2);
      // The same key on another entry adds a change there.
      const { entryId: otherEntryId } = await arrangeRatedEntry(owner);
      expect((await added(owner, otherEntryId, body)).id).not.toBe(first.id);
    });

    it('refuses a clientRequestId on a correction', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      await editRating(owner, entryId, today.id, { clientRequestId: 'key-1', rating: 3 }).expect(400);
    });

    it('adds an earlier clearing of the rating, sent as null', async () => {
      const owner = await actors.user();
      const { entryId } = await arrangeRatedEntry(owner);

      expect(await added(owner, entryId, { occurredOn: '2015', rating: null })).toMatchObject({ rating: null });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
    });

    it.each([
      ['no rating', { occurredOn: '2015' }],
      ['no date', { rating: 5 }],
      ['a rating of 11', { occurredOn: '2015', rating: 11 }],
      ['a null date', { occurredOn: null, rating: 5 }],
    ])('refuses an earlier rating with %s', async (_, body) => {
      const owner = await actors.user();
      const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

      await addRating(owner, entryId, body).expect(400);
      expect(await historyOf(owner, entryId)).toEqual([]);
    });

    it("editing a rating change's date keeps what it said before", async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      const edited = ratingChangeEnvelope(
        await editRating(owner, entryId, today.id, { occurredOn: '2010-02' }).expect(200),
        'PATCH /api/game-collections/:id/ratings/:ratingId as the owner',
      );

      expect(edited).toMatchObject({ id: today.id, occurredOn: '2010-02', rating: 6 });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
      expect((await revisionsOf(owner, entryId, today.id)).map(({ values }) => values)).toEqual([
        { occurredOn: today.occurredOn, rating: 6 },
      ]);
    });

    it('a null rating makes the change a clearing, and a null date makes its date unknown', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      const edited = ratingChangeEnvelope(
        await editRating(owner, entryId, today.id, { occurredOn: null, rating: null }).expect(200),
        'PATCH /api/game-collections/:id/ratings/:ratingId as the owner',
      );

      expect(edited).toMatchObject({ occurredOn: null, rating: null });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
    });

    it('refuses an edit that names no field', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      await editRating(owner, entryId, today.id, {}).expect(400);
    });

    it('a future date is refused with COLLECTION_DATE_IN_FUTURE, adding or editing', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);
      const future = String(new Date().getUTCFullYear() + 1);

      const refusedAdd = await addRating(owner, entryId, { occurredOn: future, rating: 5 });
      expectErrorEnvelope(refusedAdd, { status: 400, code: 'COLLECTION_DATE_IN_FUTURE' });
      expect(refusedAdd.body).toMatchObject({ field: 'occurredOn' });
      expectErrorEnvelope(await editRating(owner, entryId, today.id, { occurredOn: future }), {
        status: 400,
        code: 'COLLECTION_DATE_IN_FUTURE',
      });
      expect(await historyOf(owner, entryId)).toEqual([{ occurredOn: today.occurredOn, rating: 6 }]);
    });

    it("taking back the latest rating change keeps the entry's current rating", async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      const taken = ratingChangeEnvelope(
        await takeBack(owner, entryId, today.id).expect(200),
        'POST /api/game-collections/:id/ratings/:ratingId/retraction as the owner',
      );

      expect(taken).toMatchObject({ id: today.id, rating: 6, retractedAt: expect.any(String) });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
      // The history still lists it, flagged.
      expect(await fullHistory(owner, entryId)).toEqual([
        expect.objectContaining({ id: today.id, retractedAt: taken.retractedAt }),
      ]);
      // It changes no value a revision holds, so it keeps none.
      expect(await revisionsOf(owner, entryId, today.id)).toEqual([]);
    });

    it('a taken-back change takes only the undo: edit, restore and a second take-back answer COLLECTION_RATING_NOT_FOUND', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);
      await editRating(owner, entryId, today.id, { rating: 3 }).expect(200);
      const [revision] = await revisionsOf(owner, entryId, today.id);
      await takeBack(owner, entryId, today.id).expect(200);
      const notFound = { status: 404, code: 'COLLECTION_RATING_NOT_FOUND' };

      expectErrorEnvelope(await editRating(owner, entryId, today.id, { rating: 4 }), notFound);
      expectErrorEnvelope(await restoreRevision(owner, entryId, today.id, revision?.id ?? ''), notFound);
      expectErrorEnvelope(await takeBack(owner, entryId, today.id), notFound);
      // Its revisions stay readable.
      expect(await revisionsOf(owner, entryId, today.id)).toHaveLength(1);

      const undone = ratingChangeEnvelope(
        await undoTakeBack(owner, entryId, today.id).expect(200),
        'DELETE /api/game-collections/:id/ratings/:ratingId/retraction as the owner',
      );
      expect(undone).toMatchObject({ id: today.id, rating: 3, retractedAt: null });
      // After the undo every route works again.
      await editRating(owner, entryId, today.id, { rating: 4 }).expect(200);
    });

    // A coded 404 reads as "this row is gone" (#634): a live change must not answer one.
    it('undoing the take-back of a change that is not taken back answers 409 COLLECTION_RATING_NOT_TAKEN_BACK', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);

      expectErrorEnvelope(await undoTakeBack(owner, entryId, today.id), {
        status: 409,
        code: 'COLLECTION_RATING_NOT_TAKEN_BACK',
      });
      // A change that doesn't exist is still the 404.
      expectErrorEnvelope(await undoTakeBack(owner, entryId, 'no-such-change'), {
        status: 404,
        code: 'COLLECTION_RATING_NOT_FOUND',
      });
    });

    it('restoring a revision of a rating change records the current values first', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);
      await editRating(owner, entryId, today.id, { occurredOn: '2012', rating: 3 }).expect(200);
      const [original] = await revisionsOf(owner, entryId, today.id);

      const restored = ratingChangeEnvelope(
        await restoreRevision(owner, entryId, today.id, original?.id ?? '').expect(200),
        'POST /api/game-collections/:id/ratings/:ratingId/revisions/:revisionId/restore as the owner',
      );

      expect(restored).toMatchObject({ id: today.id, occurredOn: today.occurredOn, rating: 6 });
      expect((await readEntry(owner, entryId)).rating).toBe(6);
      // What the change said just before the restore is kept, newest first, so the restore can be undone.
      expect((await revisionsOf(owner, entryId, today.id)).map(({ values }) => values)).toEqual([
        { occurredOn: '2012', rating: 3 },
        { occurredOn: today.occurredOn, rating: 6 },
      ]);
    });

    it('a revision of another change answers COLLECTION_REVISION_NOT_FOUND', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);
      const other = await added(owner, entryId, { occurredOn: '2014', rating: 2 });
      await editRating(owner, entryId, other.id, { rating: 1 }).expect(200);
      const [foreign] = await revisionsOf(owner, entryId, other.id);

      expectErrorEnvelope(await restoreRevision(owner, entryId, today.id, foreign?.id ?? ''), {
        status: 404,
        code: 'COLLECTION_REVISION_NOT_FOUND',
      });
    });

    it('every correction stamps the change as edited by the user, so a sync leaves it alone', async () => {
      const owner = await actors.user();
      const { entryId, today } = await arrangeRatedEntry(owner);
      await editRating(owner, entryId, today.id, { rating: 3 }).expect(200);
      const [revision] = await revisionsOf(owner, entryId, today.id);

      const corrections: [string, () => Promise<unknown>][] = [
        ['an edit', () => editRating(owner, entryId, today.id, { rating: 4 }).expect(200)],
        ['a take-back', () => takeBack(owner, entryId, today.id).expect(200)],
        ['an undo of the take-back', () => undoTakeBack(owner, entryId, today.id).expect(200)],
        ['a restore', () => restoreRevision(owner, entryId, today.id, revision?.id ?? '').expect(200)],
      ];

      for (const [name, correct] of corrections) {
        await db.client.collectionRatingChange.update({ where: { id: today.id }, data: { editedByUserAt: null } });
        await correct();

        expect({ name, stamped: (await editedByUserAt(today.id)) !== null }).toEqual({ name, stamped: true });
      }

      expect(syncMayWrite(await db.client.collectionRatingChange.findUniqueOrThrow({ where: { id: today.id } }))).toBe(
        false,
      );
    });

    it("another user's rating change answers COLLECTION_ENTRY_NOT_FOUND on every route", async () => {
      const owner = await actors.user();
      const stranger = await actors.user();
      // Public, so the stranger may read the entry itself: its rating history is still the owner's alone.
      const { entryId, today } = await arrangeRatedEntry(owner, Reach.Public);
      await editRating(owner, entryId, today.id, { rating: 3 }).expect(200);
      const [revision] = await revisionsOf(owner, entryId, today.id);
      const notFound = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };

      expectErrorEnvelope(await addRating(stranger, entryId, { occurredOn: '2015', rating: 5 }), notFound);
      expectErrorEnvelope(await editRating(stranger, entryId, today.id, { rating: 9 }), notFound);
      expectErrorEnvelope(await takeBack(stranger, entryId, today.id), notFound);
      expectErrorEnvelope(await undoTakeBack(stranger, entryId, today.id), notFound);
      expectErrorEnvelope(await listRevisions(stranger, entryId, today.id), notFound);
      expectErrorEnvelope(await restoreRevision(stranger, entryId, today.id, revision?.id ?? ''), notFound);
      // None of it changed anything: the control, the owner's history as it was.
      expect(await fullHistory(owner, entryId)).toEqual([expect.objectContaining({ rating: 3, retractedAt: null })]);
    });

    // The Owner role may read and update every entry, but a rating change is
    // its entry owner's alone, whatever the grants (#1231).
    it("the Owner role correcting another user's rating change answers COLLECTION_ENTRY_NOT_FOUND", async () => {
      const entryOwner = await actors.user();
      const serverOwner = await actors.owner();
      const { entryId, today } = await arrangeRatedEntry(entryOwner);
      const notFound = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };

      expectErrorEnvelope(await addRating(serverOwner, entryId, { occurredOn: '2015', rating: 5 }), notFound);
      expectErrorEnvelope(await editRating(serverOwner, entryId, today.id, { rating: 9 }), notFound);
      expectErrorEnvelope(await takeBack(serverOwner, entryId, today.id), notFound);
      expect(await historyOf(entryOwner, entryId)).toEqual([{ occurredOn: today.occurredOn, rating: 6 }]);
    });

    it("a rating change of another of the owner's entries answers COLLECTION_RATING_NOT_FOUND", async () => {
      const owner = await actors.user();
      const { today } = await arrangeRatedEntry(owner);
      const { entryId: otherEntryId } = await arrangeRatedEntry(owner);
      const notFound = { status: 404, code: 'COLLECTION_RATING_NOT_FOUND' };

      expectErrorEnvelope(await editRating(owner, otherEntryId, today.id, { rating: 9 }), notFound);
      expectErrorEnvelope(await takeBack(owner, otherEntryId, today.id), notFound);
      expectErrorEnvelope(await undoTakeBack(owner, otherEntryId, today.id), notFound);
      expectErrorEnvelope(await listRevisions(owner, otherEntryId, today.id), notFound);
    });
  });
});
