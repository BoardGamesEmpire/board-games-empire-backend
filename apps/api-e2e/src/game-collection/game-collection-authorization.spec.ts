import { GameMedium, Visibility } from '@bge/database';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { listCollectionsEnvelope, readCollectionEnvelope } from './game-collection-wire';

/**
 * What an anonymous user may read of another user's collection (#484), against
 * real rows and the real anonymous sign-in.
 *
 * An anonymous user is a temporary guest holding `AnonymousUser` INSTEAD of
 * `User`, and the one thing that role grants is the Public collection read.
 * Every denial below follows a control showing the same row IS readable — by a
 * friend of its owner — so a denial cannot pass because the row was unreadable
 * to everyone, or because the route answered nothing at all.
 *
 * `GET /api/users/:userId/game-collections` stopped being public in the same
 * change. A request with no session used to be served the Public entries by a
 * branch around the ability layer; it is now refused before the route runs.
 * The route was `GET /api/game-collections/user/:userId` until #514.
 */
describe('game collection authorization', () => {
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

  const userCollectionPath = (userId: string) => `/api/users/${userId}/game-collections`;

  const listUserCollection = (actor: AuthenticatedActor, userId: string) =>
    request(baseUrl).get(userCollectionPath(userId)).set(actor.headers);

  const readEntry = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${id}`).set(actor.headers);

  const listOwnCollection = (actor: AuthenticatedActor) => request(baseUrl).get(COLLECTIONS_PATH).set(actor.headers);

  /**
   * One owner's collection: the same game held twice, once `Public` and once
   * `Friends` — two media, because the unique key is user × platform game ×
   * medium. The platform is seeded reference data and survives the sweep; the
   * game is created per test.
   */
  const arrangeCollection = async (ownerId: string) => {
    const platform = await db.client.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true } });
    const game = await db.client.game.create({
      data: { title: `e2e game ${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });
    const platformGame = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: platform.id },
      select: { id: true },
    });

    const publicEntry = await db.client.gameCollection.create({
      data: {
        userId: ownerId,
        platformGameId: platformGame.id,
        medium: GameMedium.Physical,
        visibility: Visibility.Public,
      },
      select: { id: true },
    });
    const friendsEntry = await db.client.gameCollection.create({
      data: {
        userId: ownerId,
        platformGameId: platformGame.id,
        medium: GameMedium.Digital,
        visibility: Visibility.Friends,
      },
      select: { id: true },
    });

    return { publicEntry, friendsEntry };
  };

  describe("another user's collection", () => {
    it('serves an anonymous guest the Public entry and not the Friends one a friend reads', async () => {
      // Actors first, rows before anyone's first authenticated request (#256
      // ordering rule): the ability cache fills lazily per user.
      const owner = await actors.user();
      const friend = await actors.user();
      const guest = await actors.anonymous();

      await befriend(db.client, owner, friend);
      const { publicEntry, friendsEntry } = await arrangeCollection(owner.user.id);

      const asFriend = listCollectionsEnvelope(
        await listUserCollection(friend, owner.user.id).expect(200),
        'GET /api/users/:userId/game-collections as a friend',
      );
      expect(asFriend.collections.map((entry) => entry.id).sort()).toEqual([publicEntry.id, friendsEntry.id].sort());

      const asGuest = listCollectionsEnvelope(
        await listUserCollection(guest, owner.user.id).expect(200),
        'GET /api/users/:userId/game-collections as an anonymous guest',
      );
      expect(asGuest.collections.map((entry) => entry.id)).toEqual([publicEntry.id]);
      // Counted over the same scope as the page (#230), not the owner's whole collection.
      expect(asGuest.total).toBe(1);
    });

    it('serves a friend the Friends entry of an owner with no preferences row, and not one whose preferences hide it', async () => {
      // The friends grant reads a missing preferences row as the schema
      // default, showing the collection (#458). Signup always writes the row,
      // so only a deleted one reaches that branch.
      const unsetOwner = await actors.user();
      const hidingOwner = await actors.user();
      const friend = await actors.user();

      await befriend(db.client, unsetOwner, friend);
      await befriend(db.client, hidingOwner, friend);
      await db.client.userPreferences.delete({ where: { userId: unsetOwner.user.id } });
      await db.client.userPreferences.update({
        where: { userId: hidingOwner.user.id },
        data: { showCollectionToFriends: false },
      });
      const unset = await arrangeCollection(unsetOwner.user.id);
      const hiding = await arrangeCollection(hidingOwner.user.id);

      const ofUnset = listCollectionsEnvelope(
        await listUserCollection(friend, unsetOwner.user.id).expect(200),
        'GET /api/users/:userId/game-collections, owner without preferences',
      );
      expect(ofUnset.collections.map((entry) => entry.id).sort()).toEqual(
        [unset.publicEntry.id, unset.friendsEntry.id].sort(),
      );

      const ofHiding = listCollectionsEnvelope(
        await listUserCollection(friend, hidingOwner.user.id).expect(200),
        'GET /api/users/:userId/game-collections, owner hiding it from friends',
      );
      expect(ofHiding.collections.map((entry) => entry.id)).toEqual([hiding.publicEntry.id]);
    });

    it('refuses a request with no session, where it used to serve the Public entries', async () => {
      const owner = await actors.user();
      await arrangeCollection(owner.user.id);

      await request(baseUrl).get(userCollectionPath(owner.user.id)).expect(401);
    });
  });

  describe('a single entry', () => {
    it('reads a Public entry for an anonymous guest and 404s the Friends one a friend reads', async () => {
      const owner = await actors.user();
      const friend = await actors.user();
      const guest = await actors.anonymous();

      await befriend(db.client, owner, friend);
      const { publicEntry, friendsEntry } = await arrangeCollection(owner.user.id);

      await readEntry(friend, friendsEntry.id).expect(200);

      const read = readCollectionEnvelope(
        await readEntry(guest, publicEntry.id).expect(200),
        'GET /api/game-collections/:id as an anonymous guest',
      );
      expect(read.collection.id).toBe(publicEntry.id);

      // 404 rather than 403: a row outside the actor's read scope is
      // indistinguishable from an absent one on this route.
      await readEntry(guest, friendsEntry.id).expect(404);
    });
  });

  describe("an anonymous guest's own reach", () => {
    it('lists its own collection as an empty page, since a guest owns nothing', async () => {
      const guest = await actors.anonymous();

      expect(
        listCollectionsEnvelope(await listOwnCollection(guest).expect(200), 'GET /api/game-collections as a guest'),
      ).toEqual({ collections: [], total: 0 });
    });

    it('is still refused the household list, which a signed-in user reads', async () => {
      const user = await actors.user();
      const guest = await actors.anonymous();

      await request(baseUrl).get('/api/households').set(user.headers).expect(200);
      await request(baseUrl).get('/api/households').set(guest.headers).expect(403);
    });
  });
});
