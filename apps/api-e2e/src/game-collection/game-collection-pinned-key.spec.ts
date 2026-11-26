import { GameMedium, GameRemovalReason, Reach, ResourceType } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangePlatformGame } from '../list/list-fixtures';
import type { Caller } from '../support/api-key';
import { mintApiKey, mintApiKeyWithArrangedScopes } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { arrangeCollectionEntry } from './game-collection-fixtures';
import { readCollectionEnvelope } from './game-collection-wire';

/**
 * An API key whose collection grants are pinned to one entry (#1288).
 *
 * `POST /game-collections` names a game, not an entry, so the route's policy
 * check passes on the action and the type alone. The service then checks the
 * row the add writes: a new entry against `create`, and an entry the user
 * already has, owned or removed, against `update`. A key pinned to one entry
 * therefore adds no other: every new entry is refused, and so is bringing back
 * a removed entry the pin doesn't name. The entry it names can still be
 * acquired again.
 *
 * `POST /api/api-keys` refuses a pin on a `create` permission (#1417), so the
 * keys that add are arranged straight in the database: a pin the route
 * refuses still narrows the key. Every refusal follows the same add from the
 * owner's session, or is followed by it, so a refusal can't pass because the
 * add fails for everyone.
 *
 * A `read`, `update` or `delete` pin the route takes, since `GameCollection`
 * is pinnable, so those keys are minted through it: each reaches the entry
 * it names, and no other. That is the e2e the pinnable list asks of a type.
 */
describe('a key pinned to one collection entry (#1288)', () => {
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

  /** `create` and `update` on collection entries, both pinned to `entryId`: what acquiring that entry again takes. */
  const keyPinnedTo = (owner: SessionActor, entryId: string) =>
    mintApiKeyWithArrangedScopes(baseUrl, db.client, owner, {
      slugs: ['create:game_collection', 'update:game_collection'],
      resourceType: ResourceType.GameCollection,
      resourceId: entryId,
    });

  const add = (caller: Caller, platformGameId: string) =>
    request(baseUrl).post(COLLECTIONS_PATH).set(caller.headers).send({ platformGameId, medium: GameMedium.Physical });

  /** Removes the entry through the owner's session, as the owner would, so its copy is removed with it. */
  const removed = async (owner: SessionActor, entryId: string) =>
    request(baseUrl)
      .delete(`${COLLECTIONS_PATH}/${entryId}`)
      .query({ reason: GameRemovalReason.Sold })
      .set(owner.headers)
      .expect(200);

  /** An entry of `ownerId`'s with one copy, and the platform game it holds. */
  const arrangeEntry = async (ownerId: string) => {
    const id = await arrangeCollectionEntry(db.client, ownerId, Reach.Private);
    const { platformGameId } = await db.client.gameCollection.findUniqueOrThrow({
      where: { id },
      select: { platformGameId: true },
    });

    return { id, platformGameId };
  };

  /** A key `owner` mints through the route, holding `slug` pinned to `entryId` and nothing else. */
  const keyWith = (owner: SessionActor, slug: string, entryId: string) =>
    mintApiKey(baseUrl, db.client, owner, {
      slugs: [slug],
      resourceType: ResourceType.GameCollection,
      resourceId: entryId,
    });

  /** The entry's removal and its count of owned copies. */
  const ownership = async (entryId: string) => ({
    deletedAt: (
      await db.client.gameCollection.findUniqueOrThrow({ where: { id: entryId }, select: { deletedAt: true } })
    ).deletedAt,
    owned: await db.client.collectionCopy.count({ where: { entryId, removedAt: null, retractedAt: null } }),
  });

  /** What the owner's collection holds: its entries, and every copy in them. */
  const held = async (ownerId: string) => ({
    entries: await db.client.gameCollection.count({ where: { userId: ownerId } }),
    copies: await db.client.collectionCopy.count({ where: { entry: { is: { userId: ownerId } } } }),
  });

  it('a key whose create grant is pinned to one entry is refused a new entry, and nothing is written (#1288)', async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const key = await keyPinnedTo(owner, named.id);
    const { platformGameId } = await arrangePlatformGame(db.client);
    const before = await held(owner.user.id);

    await add(key, platformGameId).expect(403);
    expect(await held(owner.user.id)).toEqual(before);

    // The control: the owner's session adds the same game.
    await add(owner, platformGameId).expect(201);
    expect(await held(owner.user.id)).toEqual({ entries: before.entries + 1, copies: before.copies + 1 });
  });

  it("a key pinned to one entry can't bring back a removed entry it doesn't name (#1288)", async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const other = await arrangeEntry(owner.user.id);
    const key = await keyPinnedTo(owner, named.id);
    await removed(owner, other.id);
    const before = await held(owner.user.id);

    await add(key, other.platformGameId).expect(403);
    expect(await held(owner.user.id)).toEqual(before);
    expect(
      await db.client.gameCollection.findUniqueOrThrow({ where: { id: other.id }, select: { deletedAt: true } }),
    ).toEqual({ deletedAt: expect.any(Date) });

    // The control: the owner's session brings it back.
    await add(owner, other.platformGameId).expect(201);
  });

  it('a key pinned to one entry acquires that entry again (#1288)', async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const key = await keyPinnedTo(owner, named.id);
    await removed(owner, named.id);

    const acquired = readCollectionEnvelope(
      await add(key, named.platformGameId).expect(201),
      `POST ${COLLECTIONS_PATH} with a key pinned to the entry`,
    ).collection;

    expect(acquired).toMatchObject({ id: named.id, deletedAt: null, quantity: 1 });
    // The removed copy keeps its removal, and the acquisition is a new copy.
    expect(
      await db.client.collectionCopy.findMany({
        where: { entryId: named.id },
        orderBy: { createdAt: 'asc' },
        select: { removeReason: true, removedAt: true },
      }),
    ).toEqual([
      { removeReason: GameRemovalReason.Sold, removedAt: expect.any(Date) },
      { removeReason: null, removedAt: null },
    ]);
  });

  it('a key whose read grant is pinned to one entry reads it, and no other (#1288)', async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const other = await arrangeEntry(owner.user.id);
    const key = await keyWith(owner, 'read:game_collection', named.id);

    const read = readCollectionEnvelope(
      await request(baseUrl).get(`${COLLECTIONS_PATH}/${named.id}`).set(key.headers).expect(200),
      `GET ${COLLECTIONS_PATH}/:id with a key pinned to the entry`,
    ).collection;
    expect(read).toMatchObject({ id: named.id });

    expectErrorEnvelope(await request(baseUrl).get(`${COLLECTIONS_PATH}/${other.id}`).set(key.headers), {
      status: 404,
      code: 'COLLECTION_ENTRY_NOT_FOUND',
    });

    // The control: the owner's session reads the other entry.
    await request(baseUrl).get(`${COLLECTIONS_PATH}/${other.id}`).set(owner.headers).expect(200);
  });

  it('a key whose update grant is pinned to one entry updates it, and no other (#1288)', async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const other = await arrangeEntry(owner.user.id);
    const key = await keyWith(owner, 'update:game_collection', named.id);
    const patch = (caller: Caller, entryId: string) =>
      request(baseUrl).patch(`${COLLECTIONS_PATH}/${entryId}`).set(caller.headers).send({ favorite: true });
    const favorite = async (entryId: string) =>
      (await db.client.gameCollection.findUniqueOrThrow({ where: { id: entryId }, select: { favorite: true } }))
        .favorite;

    await patch(key, named.id).expect(200);
    expect(await favorite(named.id)).toBe(true);

    expectErrorEnvelope(await patch(key, other.id), { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
    expect(await favorite(other.id)).toBeNull();

    // The control: the owner's session updates the other entry.
    await patch(owner, other.id).expect(200);
  });

  it('a key whose delete grant is pinned to one entry removes it, and no other (#1288)', async () => {
    const owner = await actors.user();
    const named = await arrangeEntry(owner.user.id);
    const other = await arrangeEntry(owner.user.id);
    const key = await keyWith(owner, 'delete:game_collection', named.id);
    const remove = (caller: Caller, entryId: string) =>
      request(baseUrl).delete(`${COLLECTIONS_PATH}/${entryId}`).set(caller.headers);

    expectErrorEnvelope(await remove(key, other.id), { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
    expect(await ownership(other.id)).toEqual({ deletedAt: null, owned: 1 });

    await remove(key, named.id).expect(200);
    expect(await ownership(named.id)).toEqual({ deletedAt: expect.any(Date), owned: 0 });

    // The control: the owner's session removes the other entry.
    await remove(owner, other.id).expect(200);
  });
});
