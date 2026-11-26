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
import { copyEnvelope, listCopiesEnvelope, readCollectionEnvelope } from './game-collection-wire';

/**
 * The copies of a collection entry, over the real routes (#1231, #1288).
 *
 * A collection entry holds copies: each its own acquisition, condition,
 * edition and removal. Its owner lists, adds, edits and removes them through
 * `/game-collections/:id/copies`, and removing the last owned copy removes
 * the entry. Each route is held to the entry's conditions: reading its copies
 * to its owner, the writes to `update`, and removing its last owned copy to
 * `delete` as well (#1288).
 */
describe('collection copies (#1231)', () => {
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

  const listCopies = (caller: SessionActor, entryId: string) =>
    request(baseUrl).get(copiesPath(entryId)).set(caller.headers);

  const addCopy = (caller: SessionActor, entryId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(copiesPath(entryId)).set(caller.headers).send(body);

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

  /** The entry as its owner reads it. */
  const readEntry = async (owner: SessionActor, entryId: string) =>
    readCollectionEnvelope(
      await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(owner.headers).expect(200),
      'GET /api/game-collections/:id as the owner',
    ).collection;

  /** The one copy an arranged entry holds. */
  const onlyCopyOf = async (entryId: string) =>
    (await db.client.collectionCopy.findFirstOrThrow({ where: { entryId }, select: { id: true } })).id;

  /** An entry of `owner`'s, added through the route with one copy, on a platform game of its own. */
  const addedEntry = async (owner: SessionActor, medium: GameMedium, copy: Record<string, unknown> = {}) => {
    const { platformGameId } = await arrangePlatformGame(db.client);
    const { collection } = readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({ platformGameId, medium, copy })
        .expect(201),
      'POST /api/game-collections as the owner',
    );

    return { entryId: collection.id, platformGameId };
  };

  it('adds a second copy with its own price and edition, and quantity becomes 2', async () => {
    const owner = await actors.user();
    const { entryId, platformGameId } = await addedEntry(owner, GameMedium.Physical, {
      pricePaid: { amount: 4000, currency: 'EUR' },
    });
    const release = await db.client.gameRelease.create({
      data: { platformGameId, editionKey: 'e2e-deluxe', editionName: 'Deluxe', releaseYear: 2019 },
      select: { id: true },
    });

    const added = copyEnvelope(
      await addCopy(owner, entryId, {
        releaseId: release.id,
        condition: GameCondition.LikeNew,
        acquiredOn: '2020-06',
        acquiredFrom: 'A friend',
        pricePaid: { amount: 2500, currency: 'USD' },
        note: 'The **deluxe** one',
      }).expect(201),
      'POST /api/game-collections/:id/copies as the owner',
    );

    expect(added).toMatchObject({
      acquiredFrom: 'A friend',
      acquiredOn: '2020-06',
      condition: GameCondition.LikeNew,
      currentValue: null,
      note: 'The **deluxe** one',
      pricePaid: { amount: 2500, currency: 'USD' },
      release: { editionName: 'Deluxe', id: release.id, releaseYear: 2019 },
      removedAt: null,
      removedOn: null,
      removeReason: null,
    });
    expect((await readEntry(owner, entryId)).quantity).toBe(2);

    // Each copy keeps its own price: the first is unchanged by the second.
    const copies = listCopiesEnvelope(
      await listCopies(owner, entryId).expect(200),
      'GET /api/game-collections/:id/copies as the owner',
    );
    expect(copies.map(({ id, pricePaid }) => ({ id, pricePaid }))).toEqual([
      { id: expect.any(String), pricePaid: { amount: 4000, currency: 'EUR' } },
      { id: added.id, pricePaid: { amount: 2500, currency: 'USD' } },
    ]);
  });

  it('refuses the 101st copy with COLLECTION_COPY_LIMIT_REACHED', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    // One owned copy from the fixture, and 99 removed ones: removed copies count too.
    await db.client.collectionCopy.createMany({
      data: Array.from({ length: 99 }, () => ({
        entryId,
        removedAt: new Date(),
        removeReason: GameRemovalReason.Sold,
      })),
    });

    const refused = await addCopy(owner, entryId, {});
    expectErrorEnvelope(refused, { status: 409, code: 'COLLECTION_COPY_LIMIT_REACHED' });
    expect(refused.body.limit).toBe(100);
    expect(await db.client.collectionCopy.count({ where: { entryId } })).toBe(100);
  });

  it("refuses a condition on a digital entry's copy with COLLECTION_CONDITION_DIGITAL", async () => {
    const owner = await actors.user();
    const { entryId } = await addedEntry(owner, GameMedium.Digital);

    expectErrorEnvelope(await addCopy(owner, entryId, { condition: GameCondition.Good }), {
      status: 400,
      code: 'COLLECTION_CONDITION_DIGITAL',
    });
    expectErrorEnvelope(await editCopy(owner, entryId, await onlyCopyOf(entryId), { condition: GameCondition.Good }), {
      status: 400,
      code: 'COLLECTION_CONDITION_DIGITAL',
    });
    expect(await db.client.collectionCopy.findMany({ where: { entryId }, select: { condition: true } })).toEqual([
      { condition: null },
    ]);
  });

  it("refuses a removal dated before the copy's acquisition with COLLECTION_DATE_ORDER", async () => {
    const owner = await actors.user();
    const { entryId } = await addedEntry(owner, GameMedium.Physical, { acquiredOn: '2020-05' });
    const copyId = await onlyCopyOf(entryId);

    expectErrorEnvelope(await removeCopy(owner, entryId, copyId, { removedOn: '2020-03' }), {
      status: 400,
      code: 'COLLECTION_DATE_ORDER',
    });
    expect(
      await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId }, select: { removedAt: true } }),
    ).toEqual({ removedAt: null });

    // The same month passes: it may end after the acquisition began.
    await removeCopy(owner, entryId, copyId, { removedOn: '2020-05' }).expect(200);
  });

  it('refuses an unknown currency with COLLECTION_CURRENCY_UNKNOWN', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);

    expectErrorEnvelope(await addCopy(owner, entryId, { pricePaid: { amount: 100, currency: 'QQQ' } }), {
      status: 400,
      code: 'COLLECTION_CURRENCY_UNKNOWN',
    });
    expectErrorEnvelope(
      await editCopy(owner, entryId, await onlyCopyOf(entryId), { currentValue: { amount: 100, currency: 'QQQ' } }),
      { status: 400, code: 'COLLECTION_CURRENCY_UNKNOWN' },
    );
    expect(await db.client.collectionCopy.count({ where: { entryId } })).toBe(1);
  });

  it('removing one of two copies leaves the entry owned', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const second = copyEnvelope(
      await addCopy(owner, entryId, {}).expect(201),
      'POST /api/game-collections/:id/copies as the owner',
    );

    const removed = copyEnvelope(
      await removeCopy(owner, entryId, second.id, { reason: GameRemovalReason.Gifted, removedOn: '2024' }).expect(200),
      'DELETE /api/game-collections/:id/copies/:copyId as the owner',
    );

    expect(removed).toMatchObject({
      id: second.id,
      removedAt: expect.any(String),
      removedOn: '2024',
      removeReason: GameRemovalReason.Gifted,
    });
    expect(await readEntry(owner, entryId)).toMatchObject({ deletedAt: null, deleteReason: null, quantity: 1 });

    // A removed copy is not removed again.
    expectErrorEnvelope(await removeCopy(owner, entryId, second.id), {
      status: 404,
      code: 'COLLECTION_COPY_NOT_FOUND',
    });
  });

  it("removing the last owned copy removes the entry, with that copy's reason", async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const copyId = await onlyCopyOf(entryId);

    await removeCopy(owner, entryId, copyId, { reason: GameRemovalReason.Traded }).expect(200);

    expect(await readEntry(owner, entryId)).toMatchObject({
      deletedAt: expect.any(String),
      deleteReason: GameRemovalReason.Traded,
      quantity: 0,
    });
    // A removal is the user's word on the copy, so a sync leaves it (#1231).
    expect(
      await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId }, select: { editedByUserAt: true } }),
    ).toEqual({ editedByUserAt: expect.any(Date) });

    // The entry's reason is a summary of its copies: correcting the copy's
    // reason corrects the entry's (#1231).
    await editCopy(owner, entryId, copyId, { removeReason: GameRemovalReason.Stolen }).expect(200);

    expect(await readEntry(owner, entryId)).toMatchObject({
      deletedAt: expect.any(String),
      deleteReason: GameRemovalReason.Stolen,
      quantity: 0,
    });
  });

  it("a copy of another user's entry answers COLLECTION_ENTRY_NOT_FOUND on every copy route", async () => {
    const owner = await actors.user();
    const stranger = await actors.user();
    // Public, so the stranger may read the entry itself: its copies are still the owner's alone.
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Public);
    const copyId = await onlyCopyOf(entryId);
    const notFound = { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' };
    const before = await db.client.collectionCopy.findMany({ where: { entryId } });

    await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}`).set(stranger.headers).expect(200);

    expectErrorEnvelope(await listCopies(stranger, entryId), notFound);
    expectErrorEnvelope(await addCopy(stranger, entryId, {}), notFound);
    expectErrorEnvelope(await editCopy(stranger, entryId, copyId, { note: 'mine now' }), notFound);
    expectErrorEnvelope(await removeCopy(stranger, entryId, copyId), notFound);
    expect(await db.client.collectionCopy.findMany({ where: { entryId } })).toEqual(before);

    // The control: the owner lists them.
    expect(
      listCopiesEnvelope(
        await listCopies(owner, entryId).expect(200),
        'GET /api/game-collections/:id/copies as the owner',
      ).map(({ id }) => id),
    ).toEqual([copyId]);
  });

  it('editing a copy stamps it as edited by the user', async () => {
    const owner = await actors.user();
    const entryId = await arrangeCollectionEntry(db.client, owner.user.id, Reach.Private);
    const copyId = await onlyCopyOf(entryId);
    const stamp = async () =>
      (await db.client.collectionCopy.findUniqueOrThrow({ where: { id: copyId }, select: { editedByUserAt: true } }))
        .editedByUserAt;
    expect(await stamp()).toBeNull();

    const edited = copyEnvelope(
      await editCopy(owner, entryId, copyId, { note: 'Sleeved', acquiredOn: '2019' }).expect(200),
      'PATCH /api/game-collections/:id/copies/:copyId as the owner',
    );

    expect(edited).toMatchObject({ id: copyId, note: 'Sleeved', acquiredOn: '2019' });
    expect(await stamp()).toEqual(expect.any(Date));
  });
});
