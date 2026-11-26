import { GameCondition, GameMedium, GameRemovalReason, Reach } from '@bge/database';
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
  copyEnvelope,
  listCopiesEnvelope,
  listRevisionsEnvelope,
  ownerRowCopies,
  readCollectionEnvelope,
} from './game-collection-wire';

/**
 * Correcting a copy keeps what it said before, over the real routes (#1231).
 *
 * Each user write of a copy (an edit, a removal, a restore, and the entry's
 * removal for each copy it removes) first keeps the copy's values as a
 * revision. The owner lists a copy's revisions and restores one, which
 * writes its values back as a correction of its own. Like the copy's
 * details, the history is the entry owner's alone, whatever the entry's
 * reach. Every response is parsed through a strict shape, so a field a
 * revision must never carry (when the user last edited the copy, its
 * upstream account, the add's client request id) fails the test.
 */
describe('copy corrections (#1231)', () => {
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

  const copiesPath = (entryId: string) => `${COLLECTIONS_PATH}/${entryId}/copies`;
  const revisionsPath = (entryId: string, copyId: string) => `${copiesPath(entryId)}/${copyId}/revisions`;

  const editCopy = (caller: SessionActor, entryId: string, copyId: string, body: Record<string, unknown>) =>
    request(baseUrl)
      .patch(`${copiesPath(entryId)}/${copyId}`)
      .set(caller.headers)
      .send(body);

  const removeCopy = (caller: SessionActor, entryId: string, copyId: string, query: Record<string, string> = {}) =>
    request(baseUrl)
      .delete(`${copiesPath(entryId)}/${copyId}`)
      .query(query)
      .set(caller.headers);

  const listRevisionsOf = (caller: SessionActor, entryId: string, copyId: string) =>
    request(baseUrl).get(revisionsPath(entryId, copyId)).set(caller.headers);

  const restore = (caller: SessionActor, entryId: string, copyId: string, revisionId: string) =>
    request(baseUrl)
      .post(`${revisionsPath(entryId, copyId)}/${revisionId}/restore`)
      .set(caller.headers);

  const retractionPath = (entryId: string, copyId: string) => `${copiesPath(entryId)}/${copyId}/retraction`;

  const takeBack = (caller: SessionActor, entryId: string, copyId: string) =>
    request(baseUrl).post(retractionPath(entryId, copyId)).set(caller.headers);

  const undoTakeBack = (caller: SessionActor, entryId: string, copyId: string) =>
    request(baseUrl).delete(retractionPath(entryId, copyId)).set(caller.headers);

  /** Takes the copy back as the owner, failing the test unless it answers 200 with the copy. */
  const takenBack = async (owner: SessionActor, entryId: string, copyId: string) =>
    copyEnvelope(
      await takeBack(owner, entryId, copyId).expect(200),
      'POST /api/game-collections/:id/copies/:copyId/retraction as the owner',
    );

  /** Undoes the copy's take-back as the owner, failing the test unless it answers 200 with the copy. */
  const takeBackUndone = async (owner: SessionActor, entryId: string, copyId: string) =>
    copyEnvelope(
      await undoTakeBack(owner, entryId, copyId).expect(200),
      'DELETE /api/game-collections/:id/copies/:copyId/retraction as the owner',
    );

  /** Every copy of the entry, as its owner lists them. */
  const copiesOf = async (owner: SessionActor, entryId: string) =>
    listCopiesEnvelope(
      await request(baseUrl).get(copiesPath(entryId)).set(owner.headers).expect(200),
      'GET /api/game-collections/:id/copies as the owner',
    );

  /** Adds a copy to the entry as the owner, and answers it. */
  const addedCopy = async (owner: SessionActor, entryId: string, body: Record<string, unknown> = {}) =>
    copyEnvelope(
      await request(baseUrl).post(copiesPath(entryId)).set(owner.headers).send(body).expect(201),
      'POST /api/game-collections/:id/copies as the owner',
    );

  /** The copy's revisions as its owner reads them, newest first. */
  const revisionsOf = async (owner: SessionActor, entryId: string, copyId: string) =>
    listRevisionsEnvelope(
      await listRevisionsOf(owner, entryId, copyId).expect(200),
      'GET /api/game-collections/:id/copies/:copyId/revisions as the owner',
    );

  /** The copy's newest revision, failing the test when it has none. */
  const newestRevisionOf = async (owner: SessionActor, entryId: string, copyId: string) => {
    const [newest] = await revisionsOf(owner, entryId, copyId);
    if (newest === undefined) {
      throw new Error(`copy ${copyId} kept no revision`);
    }

    return newest;
  };

  /** Restores the revision as the owner, failing the test unless it answers 200 with the copy. */
  const restored = async (owner: SessionActor, entryId: string, copyId: string, revisionId: string) =>
    copyEnvelope(
      await restore(owner, entryId, copyId, revisionId).expect(200),
      'POST /api/game-collections/:id/copies/:copyId/revisions/:revisionId/restore as the owner',
    );

  /** The entry as its owner reads it. */
  const readEntry = async (owner: SessionActor, entryId: string) =>
    readCollectionEnvelope(
      await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(owner.headers).expect(200),
      'GET /api/game-collections/:id as the owner',
    ).collection;

  /** The one copy an arranged entry holds. */
  const onlyCopyOf = async (entryId: string) =>
    (await db.client.collectionCopy.findFirstOrThrow({ where: { entryId }, select: { id: true } })).id;

  /** An entry of `owner`'s, added through the route with one copy described by `copy`. */
  const addedEntry = async (owner: SessionActor, copy: Record<string, unknown> = {}) => {
    const { platformGameId } = await arrangePlatformGame(db.client);
    const { collection } = readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({ platformGameId, medium: GameMedium.Physical, copy })
        .expect(201),
      'POST /api/game-collections as the owner',
    );

    return { entryId: collection.id, copyId: await onlyCopyOf(collection.id), platformGameId };
  };

  it('editing a copy keeps what it said before as a revision (#1231)', async () => {
    const owner = await actors.user();
    const { entryId, copyId } = await addedEntry(owner, {
      acquiredOn: '2019-03',
      condition: GameCondition.Good,
      note: 'Unsleeved',
      pricePaid: { amount: 4000, currency: 'EUR' },
    });

    await editCopy(owner, entryId, copyId, { note: 'Sleeved', pricePaid: null }).expect(200);

    const revisions = await revisionsOf(owner, entryId, copyId);
    expect(revisions).toEqual([
      {
        createdAt: expect.any(String),
        id: expect.any(String),
        values: {
          acquiredFrom: null,
          acquiredOn: '2019-03',
          condition: GameCondition.Good,
          currentValue: null,
          note: 'Unsleeved',
          pricePaid: { amount: 4000, currency: 'EUR' },
          release: null,
          removedAt: null,
          removedOn: null,
          removeReason: null,
        },
      },
    ]);
  });

  it('removing a copy keeps what it said before, so restoring that revision makes it owned again and brings the entry back (#1231)', async () => {
    const owner = await actors.user();
    const { entryId, copyId } = await addedEntry(owner, { note: 'Mine' });

    await removeCopy(owner, entryId, copyId, { reason: GameRemovalReason.Sold, removedOn: '2024' }).expect(200);
    expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: expect.any(String), quantity: 0 });

    const beforeRemoval = await newestRevisionOf(owner, entryId, copyId);
    expect(beforeRemoval.values).toMatchObject({ note: 'Mine', removedAt: null, removeReason: null });

    const copy = await restored(owner, entryId, copyId, beforeRemoval.id);

    expect(copy).toMatchObject({ id: copyId, note: 'Mine', removedAt: null, removedOn: null, removeReason: null });
    expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, deleteReason: null, quantity: 1 });
  });

  it('restoring a revision records the current values as a revision first, so a restore can be undone (#1231)', async () => {
    const owner = await actors.user();
    const { entryId, copyId } = await addedEntry(owner, { note: 'First' });
    await editCopy(owner, entryId, copyId, { note: 'Second' }).expect(200);
    const first = await newestRevisionOf(owner, entryId, copyId);

    await restored(owner, entryId, copyId, first.id);

    const revisions = await revisionsOf(owner, entryId, copyId);
    expect(revisions.map(({ values }) => values.note)).toEqual(['Second', 'First']);

    // Restoring the newest undoes the restore.
    const undone = await restored(owner, entryId, copyId, (await newestRevisionOf(owner, entryId, copyId)).id);
    expect(undone.note).toBe('Second');
    expect((await revisionsOf(owner, entryId, copyId)).map(({ values }) => values.note)).toEqual([
      'First',
      'Second',
      'First',
    ]);
  });

  // The entry takes the reason of the removal the restore brings back, as
  // the copy removal gives it its own (#1231).
  it('restoring a removal of the last owned copy removes the entry again, with the restored reason (#1231)', async () => {
    const owner = await actors.user();
    const { entryId, copyId } = await addedEntry(owner);
    await removeCopy(owner, entryId, copyId, { reason: GameRemovalReason.Traded }).expect(200);
    const beforeRemoval = await newestRevisionOf(owner, entryId, copyId);
    await restored(owner, entryId, copyId, beforeRemoval.id);
    expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, quantity: 1 });

    // The restore kept the removal as a revision of its own.
    const removal = await newestRevisionOf(owner, entryId, copyId);
    expect(removal.values).toMatchObject({ removedAt: expect.any(String), removeReason: GameRemovalReason.Traded });

    const copy = await restored(owner, entryId, copyId, removal.id);

    // The removal's date and reason are the revision's; the copy is removed
    // by this restore, so the removal is recorded as written now.
    expect(copy).toMatchObject({
      removedAt: expect.any(String),
      removedOn: removal.values.removedOn,
      removeReason: GameRemovalReason.Traded,
    });
    expect(copy.removedAt).not.toBe(removal.values.removedAt);
    expect(await readEntry(owner, entryId)).toMatchObject({
      deletedAt: expect.any(String),
      deleteReason: GameRemovalReason.Traded,
      quantity: 0,
    });
  });

  // Review Focus 5: an edition deleted since the revision was kept must not
  // fail the restore on a foreign key; the copy gets none (#1231).
  it('a revision whose release has since gone restores with no release (#1231)', async () => {
    const owner = await actors.user();
    const { platformGameId } = await arrangePlatformGame(db.client);
    const release = await db.client.gameRelease.create({
      data: { platformGameId, editionKey: 'e2e-going', editionName: 'Going', releaseYear: 2019 },
      select: { id: true },
    });
    const { collection } = readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({ platformGameId, medium: GameMedium.Physical, copy: { releaseId: release.id, note: 'Deluxe' } })
        .expect(201),
      'POST /api/game-collections as the owner',
    );
    const entryId = collection.id;
    const copyId = await onlyCopyOf(entryId);
    await editCopy(owner, entryId, copyId, { note: 'Changed' }).expect(200);
    const kept = await newestRevisionOf(owner, entryId, copyId);
    expect(kept.values.release).toEqual({ editionName: 'Going', id: release.id, releaseYear: 2019 });

    await db.client.gameRelease.delete({ where: { id: release.id } });

    // The list reads the edition as it is now: none.
    const listed = await newestRevisionOf(owner, entryId, copyId);
    expect(listed.values).toMatchObject({ note: 'Deluxe', release: null });

    const copy = await restored(owner, entryId, copyId, kept.id);

    expect(copy).toMatchObject({ id: copyId, note: 'Deluxe', release: null });
  });

  // The stored values are read back through their schema: one that fails it
  // can't be restored, and the client is told the revision isn't there.
  it('a stored revision that fails the schema answers COLLECTION_REVISION_NOT_FOUND (#1231)', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const copyId = await onlyCopyOf(entryId);
    const damaged = await db.client.collectionCopyRevision.create({
      data: { copyId, values: { note: 7 } },
      select: { id: true },
    });
    const before = await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId } });

    expectErrorEnvelope(await restore(owner, entryId, copyId, damaged.id), {
      status: 404,
      code: 'COLLECTION_REVISION_NOT_FOUND',
    });
    expect(await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId } })).toEqual(before);

    // It can't be restored, so the list leaves it out.
    expect(await revisionsOf(owner, entryId, copyId)).toEqual([]);
  });

  // A restore is the user's word on the copy, so a sync leaves it (#1231).
  it('restoring a revision stamps the copy as edited by the user (#1231)', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const copyId = await onlyCopyOf(entryId);
    const stamp = async () =>
      (await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId }, select: { editedByUserAt: true } }))
        .editedByUserAt;
    // Kept by a sync's write, say: the copy itself is not yet stamped.
    const kept = await db.client.collectionCopyRevision.create({
      data: {
        copyId,
        values: {
          acquiredFrom: null,
          acquiredOn: '2018-01-01',
          acquiredOnPrecision: 'Year',
          condition: null,
          currentValueAmount: null,
          currentValueCurrency: null,
          note: 'Synced',
          pricePaidAmount: null,
          pricePaidCurrency: null,
          releaseId: null,
          removedAt: null,
          removedOn: null,
          removedOnPrecision: null,
          removeReason: null,
        },
      },
      select: { id: true },
    });
    expect(await stamp()).toBeNull();

    const copy = await restored(owner, entryId, copyId, kept.id);

    expect(copy).toMatchObject({ acquiredOn: '2018', note: 'Synced' });
    expect(await stamp()).toEqual(expect.any(Date));
  });

  // Removing the entry removes each copy it still owns, and each keeps what
  // it said before, so one copy's removal can be undone on its own (#1231).
  it('removing the entry keeps a revision of each copy it removes (#1231)', async () => {
    const owner = await actors.user();
    const { entryId, copyId } = await addedEntry(owner, { note: 'First' });
    const second = copyEnvelope(
      await request(baseUrl).post(copiesPath(entryId)).set(owner.headers).send({ note: 'Second' }).expect(201),
      'POST /api/game-collections/:id/copies as the owner',
    );

    await request(baseUrl).delete(`${COLLECTIONS_PATH}/${entryId}`).set(owner.headers).expect(200);

    const first = await newestRevisionOf(owner, entryId, copyId);
    expect(first.values).toMatchObject({ note: 'First', removedAt: null });
    const other = await newestRevisionOf(owner, entryId, second.id);
    expect(other.values).toMatchObject({ note: 'Second', removedAt: null });

    await restored(owner, entryId, second.id, other.id);
    expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, quantity: 1 });
  });

  it("another user's revisions answer COLLECTION_ENTRY_NOT_FOUND (#1231)", async () => {
    const owner = await actors.user();
    const stranger = await actors.user();
    // Public, so the stranger may read the entry itself: its copies' history
    // is still the owner's alone.
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Public);
    const copyId = await onlyCopyOf(entryId);
    await editCopy(owner, entryId, copyId, { note: 'Mine' }).expect(200);
    const kept = await newestRevisionOf(owner, entryId, copyId);
    const notFound = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };

    await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(stranger.headers).expect(200);

    expectErrorEnvelope(await listRevisionsOf(stranger, entryId, copyId), notFound);
    expectErrorEnvelope(await restore(stranger, entryId, copyId, kept.id), notFound);
    expect(await db.client.collectionCopyRevision.count({ where: { copyId } })).toBe(1);

    // A revision of another copy, even the owner's own, is not this copy's.
    const otherEntryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const otherCopyId = await onlyCopyOf(otherEntryId);
    expectErrorEnvelope(await restore(owner, otherEntryId, otherCopyId, kept.id), {
      status: 404,
      code: 'COLLECTION_REVISION_NOT_FOUND',
    });
    expectErrorEnvelope(await listRevisionsOf(owner, otherEntryId, copyId), {
      status: 404,
      code: 'COLLECTION_COPY_NOT_FOUND',
    });

    // The control: the owner restores it.
    expect(await restored(owner, entryId, copyId, kept.id)).toMatchObject({ id: copyId, note: null });
  });
  describe('taking back a copy (#1231)', () => {
    // A copy taken back never existed: it counts as neither owned nor
    // removed, so it leaves the entry's quantity and its rows, and only the
    // copies list shows it, flagged, so its owner can undo it.
    it("taking back a copy leaves it out of quantity and out of the owner's rows, and keeps it in the copies list as taken back (#1231)", async () => {
      const owner = await actors.user();
      const { entryId, copyId } = await addedEntry(owner, { note: 'Real' });
      const mistaken = await addedCopy(owner, entryId, { note: 'Never had it' });
      expect(mistaken.retractedAt).toBeNull();

      const copy = await takenBack(owner, entryId, mistaken.id);

      expect(copy).toMatchObject({ id: mistaken.id, note: 'Never had it', retractedAt: expect.any(String) });
      const row = await readEntry(owner, entryId);
      expect(row).toMatchObject({ deletedAt: null, quantity: 1 });
      expect(ownerRowCopies(row, 'GET /api/game-collections/:id as the owner').map(({ id }) => id)).toEqual([copyId]);
      expect(await copiesOf(owner, entryId)).toEqual([
        expect.objectContaining({ id: copyId, retractedAt: null }),
        expect.objectContaining({ id: mistaken.id, removedAt: null, retractedAt: copy.retractedAt }),
      ]);
    });

    it('taking back the last owned copy is refused with COLLECTION_LAST_COPY (#1231)', async () => {
      const owner = await actors.user();
      const { entryId, copyId } = await addedEntry(owner);
      const sold = await addedCopy(owner, entryId);
      await removeCopy(owner, entryId, sold.id, { reason: GameRemovalReason.Sold }).expect(200);

      expectErrorEnvelope(await takeBack(owner, entryId, copyId), { status: 409, code: 'COLLECTION_LAST_COPY' });
      expect(
        (await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId }, select: { retractedAt: true } }))
          .retractedAt,
      ).toBeNull();

      // A removed copy isn't owned, so taking it back leaves the entry as it was.
      expect(await takenBack(owner, entryId, sold.id)).toMatchObject({ retractedAt: expect.any(String) });
      expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, quantity: 1 });
    });

    it('undoing a take-back counts the copy again (#1231)', async () => {
      const owner = await actors.user();
      const { entryId } = await addedEntry(owner);
      const second = await addedCopy(owner, entryId, { note: 'Second' });
      await takenBack(owner, entryId, second.id);
      expect(await readEntry(owner, entryId)).toMatchObject({ quantity: 1 });

      const copy = await takeBackUndone(owner, entryId, second.id);

      expect(copy).toMatchObject({ id: second.id, note: 'Second', retractedAt: null });
      expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, quantity: 2 });
    });

    // A take-back is the user's word on the copy, so a sync never brings it
    // back (#1231, #1227). It changes none of the values a revision holds,
    // so it keeps none, and nor does the undo.
    it('taking back stamps the copy as edited by the user, and keeps no revision (#1231)', async () => {
      const owner = await actors.user();
      const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
      const second = await db.client.collectionCopy.create({ data: { entryId, note: 'Synced' }, select: { id: true } });
      const stamp = async () =>
        (
          await db.client.collectionCopy.findUniqueOrThrow({
            where: { id: second.id },
            select: { editedByUserAt: true },
          })
        ).editedByUserAt;
      expect(await stamp()).toBeNull();

      await takenBack(owner, entryId, second.id);

      expect(await stamp()).toEqual(expect.any(Date));
      expect(await db.client.collectionCopyRevision.count({ where: { copyId: second.id } })).toBe(0);

      await takeBackUndone(owner, entryId, second.id);
      expect(await db.client.collectionCopyRevision.count({ where: { copyId: second.id } })).toBe(0);
    });

    // A taken-back copy is no removal, so a removed entry whose only removed
    // copy is taken back stays removed, with no reason left; the undo gives
    // the reason back (#1231).
    it("taking back a removed entry's only removed copy leaves it removed with no reason, and the undo gives the reason back (#1231)", async () => {
      const owner = await actors.user();
      const { entryId, copyId } = await addedEntry(owner);
      await removeCopy(owner, entryId, copyId, { reason: GameRemovalReason.Sold }).expect(200);
      expect(await readEntry(owner, entryId)).toMatchObject({
        deletedAt: expect.any(String),
        deleteReason: GameRemovalReason.Sold,
      });

      await takenBack(owner, entryId, copyId);
      expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: expect.any(String), deleteReason: null });

      await takeBackUndone(owner, entryId, copyId);
      expect(await readEntry(owner, entryId)).toMatchObject({
        deletedAt: expect.any(String),
        deleteReason: GameRemovalReason.Sold,
        quantity: 0,
      });
    });

    // A taken-back copy takes only the undo: an edit, a removal or a restore
    // of it is told the copy isn't there, and its history stays readable
    // (#1231).
    it('taking back an already taken-back copy answers COLLECTION_COPY_NOT_FOUND, as every write but the undo does (#1231)', async () => {
      const owner = await actors.user();
      const { entryId } = await addedEntry(owner);
      const second = await addedCopy(owner, entryId, { note: 'First word' });
      await editCopy(owner, entryId, second.id, { note: 'Second word' }).expect(200);
      await takenBack(owner, entryId, second.id);
      const kept = await newestRevisionOf(owner, entryId, second.id);
      const notFound = { status: 404, code: 'COLLECTION_COPY_NOT_FOUND' };

      expectErrorEnvelope(await takeBack(owner, entryId, second.id), notFound);
      expectErrorEnvelope(await editCopy(owner, entryId, second.id, { note: 'x' }), notFound);
      expectErrorEnvelope(await removeCopy(owner, entryId, second.id), notFound);
      expectErrorEnvelope(await restore(owner, entryId, second.id, kept.id), notFound);

      // Undone, the copy takes every write again. A second undo is refused
      // with a 409, not the copy's 404: the copy is still there (#634).
      await takeBackUndone(owner, entryId, second.id);
      expectErrorEnvelope(await undoTakeBack(owner, entryId, second.id), {
        status: 409,
        code: 'COLLECTION_COPY_NOT_TAKEN_BACK',
      });
      await editCopy(owner, entryId, second.id, { note: 'Third word' }).expect(200);
      expectErrorEnvelope(await undoTakeBack(owner, entryId, 'no-such-copy'), notFound);
    });

    it("another user's copy can't be taken back, nor its take-back undone (#1231)", async () => {
      const owner = await actors.user();
      const stranger = await actors.user();
      const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Public);
      const second = await db.client.collectionCopy.create({ data: { entryId }, select: { id: true } });
      const notFound = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };

      expectErrorEnvelope(await takeBack(stranger, entryId, second.id), notFound);
      await takenBack(owner, entryId, second.id);
      expectErrorEnvelope(await undoTakeBack(stranger, entryId, second.id), notFound);
      expect(
        (await db.client.collectionCopy.findUniqueOrThrow({ where: { id: second.id }, select: { retractedAt: true } }))
          .retractedAt,
      ).toEqual(expect.any(Date));
    });
  });
});
