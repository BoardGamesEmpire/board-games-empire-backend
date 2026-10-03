import { Visibility } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeCollectionEntry } from './game-collection-fixtures';
import { listCollectionsEnvelope, readCollectionEnvelope } from './game-collection-wire';

/**
 * Which rows the collection lists answer with, over the real routes (#514).
 *
 * `GET /api/game-collections` is the caller's own collection. It already
 * filtered on the caller, so #514 changes none of its rows. It composes that
 * scope now, and the staff test below is there for a later regression: staff
 * read every collection entry on the server, so a list that dropped its scope
 * would widen theirs first. The test opens with a by-id read showing staff do
 * reach a stranger's Private entry, which a plain user is refused. Without it,
 * a list that left the entry out because nobody could read it would pass too.
 *
 * Another user's collection moved to `GET /api/users/:userId/game-collections`.
 * Its rows are the path user's for every caller; its visibility tests are in
 * `game-collection-authorization.spec.ts`.
 *
 * Collection reads are never response-cached, but no test lists before the
 * writes the list must reflect all the same.
 */
describe('game collection read scope', () => {
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

  const readEntry = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${id}`).set(actor.headers);

  const listOwnCollection = (actor: AuthenticatedActor) => request(baseUrl).get(COLLECTIONS_PATH).set(actor.headers);

  const arrangeEntry = (ownerId: string, visibility: Visibility) =>
    arrangeCollectionEntry(db.client, ownerId, visibility);

  describe('GET /api/game-collections', () => {
    it("lists staff only their own entries, while each still reads a stranger's Private entry by id", async () => {
      const [serverOwner, admin, moderator, plainUser, stranger] = await Promise.all([
        actors.owner(),
        actors.admin(),
        actors.moderator(),
        actors.user(),
        actors.user(),
      ]);

      const strangersEntry = await arrangeEntry(stranger.user.id, Visibility.Private);
      const staff = [
        ['an admin', admin, await arrangeEntry(admin.user.id, Visibility.Private)],
        ['a moderator', moderator, await arrangeEntry(moderator.user.id, Visibility.Private)],
        ["the server's Owner", serverOwner, await arrangeEntry(serverOwner.user.id, Visibility.Private)],
      ] as const;

      // The control. Admin and Moderator read the stranger's entry through
      // `read:public_content`, and the Owner through `manage:all`. A plain user
      // is refused the same entry, so the reads above come from the staff
      // grants and not from the entry being open to everyone.
      for (const [who, actor] of staff) {
        const read = readCollectionEnvelope(
          await readEntry(actor, strangersEntry).expect(200),
          `GET /api/game-collections/:id as ${who}`,
        );
        expect(read.collection.id).toBe(strangersEntry);
      }
      await readEntry(plainUser, strangersEntry).expect(404);

      for (const [who, actor, ownId] of staff) {
        const page = listCollectionsEnvelope(
          await listOwnCollection(actor).expect(200),
          `GET /api/game-collections as ${who}`,
        );
        expect(page.collections.map((entry) => entry.id)).toEqual([ownId]);
        expect(page.total).toBe(1);
      }
    });
  });

  describe("another user's collection", () => {
    // The route moved under the user it names. The old path matches no route,
    // so a signed-in caller is told it does not exist rather than served it.
    it('is no longer served at its old path', async () => {
      const owner = await actors.user();
      const viewer = await actors.user();
      await arrangeEntry(owner.user.id, Visibility.Public);

      // The control: the same caller reads the same collection at the new path.
      const page = listCollectionsEnvelope(
        await request(baseUrl).get(`/api/users/${owner.user.id}/game-collections`).set(viewer.headers).expect(200),
        'GET /api/users/:userId/game-collections',
      );
      expect(page.total).toBe(1);

      await request(baseUrl).get(`${COLLECTIONS_PATH}/user/${owner.user.id}`).set(viewer.headers).expect(404);
    });
  });
});
