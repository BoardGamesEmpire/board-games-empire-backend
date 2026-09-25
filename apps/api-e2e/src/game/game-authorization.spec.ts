import { Visibility, type DatabaseService } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameEnvelope, listGamesEnvelope, localSearchGameIds } from './game-wire';

/**
 * Who may read and change a game (#472, #491), against real rows.
 *
 * A game carries a visibility its creator chooses. A Public game is everyone's
 * to read; a Private one is its creator's, plus staff through
 * `read:public_content`. Before #472 `read:game` carried no condition, so every
 * signed-in user read every private game; before #491 the create and update
 * DTOs declared the field under the wrong name, so no private game could be
 * made through the API at all.
 *
 * Every denial below is paired with a control on the same row or the same
 * route, so it cannot pass because the row was unreadable to everyone or the
 * route answered nothing.
 */
describe('game authorization', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GAMES_PATH = '/api/games';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listGames = (actor: AuthenticatedActor) => request(baseUrl).get(GAMES_PATH).set(actor.headers);

  const readGame = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${GAMES_PATH}/${id}`).set(actor.headers);

  const createGame = (actor: AuthenticatedActor, body: Record<string, unknown>) =>
    request(baseUrl).post(GAMES_PATH).set(actor.headers).send(body);

  const updateGame = (actor: AuthenticatedActor, id: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${GAMES_PATH}/${id}`).set(actor.headers).send(body);

  // External gateways are left out: this suite runs no coordinator, and the
  // local half is the one that reads the Game table.
  const searchGames = (actor: AuthenticatedActor, query: string) =>
    request(baseUrl).get(`${GAMES_PATH}/search`).query({ query, includeExternal: false }).set(actor.headers);

  const listedIds = async (actor: AuthenticatedActor, who: string) =>
    listGamesEnvelope(await listGames(actor).expect(200), `GET /api/games as ${who}`).games.map((game) => game.id);

  const searchedIds = async (actor: AuthenticatedActor, query: string, who: string) =>
    localSearchGameIds(await searchGames(actor, query).expect(200), `GET /api/games/search as ${who}`);

  const arrangeGame = (createdById: string, visibility: Visibility, title = `e2e game ${randomUUID().slice(0, 8)}`) =>
    db.client.game.create({ data: { title, visibility, createdById }, select: { id: true } });

  /**
   * A game as an import leaves it: owned by the service account and Public.
   * The account is ensured the way the import path ensures it, rather than
   * waited for: provisioning creates it only after the Owner's roles land.
   */
  const arrangeImportedGame = async () => {
    const serviceAccount = await new ServiceAccountService(db.client as unknown as DatabaseService).resolveOrEnsure();

    return arrangeGame(serviceAccount.id, Visibility.Public);
  };

  const visibilityOf = async (id: string) =>
    (await db.client.game.findUniqueOrThrow({ where: { id }, select: { visibility: true } })).visibility;

  describe('reading a game', () => {
    it('serves a private game to its creator and to no other user, by id and in the list', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const privateGame = await arrangeGame(creator.user.id, Visibility.Private);
      const publicGame = await arrangeGame(creator.user.id, Visibility.Public);

      expect((await listedIds(creator, 'the creator')).sort()).toEqual([privateGame.id, publicGame.id].sort());
      await readGame(creator, privateGame.id).expect(200);

      // The control: the other user reads the creator's Public game, so the
      // denials after it are about the private row, not the route.
      expect(await listedIds(other, 'another user')).toEqual([publicGame.id]);
      await readGame(other, publicGame.id).expect(200);

      // The game is there and the caller may not see it: 403, as for households.
      await readGame(other, privateGame.id).expect(403);
    });

    it('serves a private game to staff through read:public_content', async () => {
      const creator = await actors.user();
      const admin = await actors.admin();

      const privateGame = await arrangeGame(creator.user.id, Visibility.Private);

      expect(await listedIds(admin, 'an admin')).toEqual([privateGame.id]);
      const read = await readGame(admin, privateGame.id).expect(200);
      expect(gameEnvelope(read, 'GET /api/games/:id as an admin').game.id).toBe(privateGame.id);
    });

    it('refuses an anonymous guest both routes, Public games included', async () => {
      // `AnonymousUser` holds no game read at all (#484), so the guard refuses
      // before a row is read.
      const creator = await actors.user();
      const publicGame = await arrangeGame(creator.user.id, Visibility.Public);
      const guest = await actors.anonymous();

      await readGame(creator, publicGame.id).expect(200);

      await listGames(guest).expect(403);
      await readGame(guest, publicGame.id).expect(403);
    });
  });

  describe('creating a game', () => {
    it('keeps the visibility it was sent, so a private game is its creator’s alone', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const created = await createGame(creator, { title: 'Private prototype', visibility: Visibility.Private }).expect(
        201,
      );
      const { game } = gameEnvelope(created, 'POST /api/games');

      expect(game.visibility).toBe(Visibility.Private);
      expect(game.createdById).toBe(creator.user.id);

      await readGame(creator, game.id).expect(200);
      await readGame(other, game.id).expect(403);
    });

    it.each([Visibility.Friends, Visibility.Household, Visibility.FriendsOfFriends])(
      'refuses %s with 400 — no game read rule honours it yet',
      async (visibility) => {
        const creator = await actors.user();

        await createGame(creator, { title: 'Tiered prototype', visibility }).expect(400);
      },
    );

    it('refuses the old `visible` field with 400 rather than failing inside Prisma', async () => {
      // #491: the DTO declared `visible`, which is not a Game column, so the
      // spread into `game.create` failed as a 500.
      const creator = await actors.user();

      await createGame(creator, { title: 'Misnamed prototype', visible: Visibility.Private }).expect(400);
    });

    it('refuses an explicit null visibility with 400 on create and on update', async () => {
      // The column is not nullable, so a null that got past validation would
      // fail inside Prisma as a 500.
      const creator = await actors.user();
      const game = await arrangeGame(creator.user.id, Visibility.Public);

      await createGame(creator, { title: 'Null prototype', visibility: null }).expect(400);
      await updateGame(creator, game.id, { visibility: null }).expect(400);
      expect(await visibilityOf(game.id)).toBe(Visibility.Public);
    });
  });

  describe('updating a game', () => {
    it('lets the creator make their game private, and refuses anyone else with 403', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const game = await arrangeGame(creator.user.id, Visibility.Public);

      await updateGame(other, game.id, { visibility: Visibility.Private }).expect(403);
      expect(await visibilityOf(game.id)).toBe(Visibility.Public);

      await updateGame(creator, game.id, { visibility: Visibility.Private }).expect(200);
      expect(await visibilityOf(game.id)).toBe(Visibility.Private);

      await readGame(other, game.id).expect(403);
    });

    it('refuses to make an imported game private, even for an admin', async () => {
      // Re-import never rewrites visibility, so an imported game made private
      // would stay private for good.
      const admin = await actors.admin();
      const user = await actors.user();
      const imported = await arrangeImportedGame();

      await updateGame(admin, imported.id, { visibility: Visibility.Private }).expect(400);
      expect(await visibilityOf(imported.id)).toBe(Visibility.Public);

      // The control: the admin may edit the game, just not privatize it.
      await updateGame(admin, imported.id, { title: 'Renamed import' }).expect(200);

      // A user who may not edit it at all hears that, not the rule above.
      await updateGame(user, imported.id, { visibility: Visibility.Private }).expect(403);
    });
  });

  describe('contributing media to a game', () => {
    const contribute = (actor: AuthenticatedActor, mediaObjectId: string, gameId: string) =>
      request(baseUrl)
        .post(`/api/media/${mediaObjectId}/contribute`)
        .set(actor.headers)
        .send({ subjectType: 'Game', subjectId: gameId });

    /** A stored image the contributor owns; a contribution never reads the bytes. */
    const arrangeOwnedImage = (ownerId: string) =>
      db.client.mediaObject.create({
        data: {
          ownerId,
          uploaderId: ownerId,
          driverSlug: 'e2e',
          driverKey: `e2e/${randomUUID()}`,
          sizeBytes: 1n,
          mimeType: 'image/png',
          checksum: 'e2e',
        },
        select: { id: true },
      });

    it('refuses a contribution to a private game its contributor cannot read', async () => {
      // With approval off, a contribution attaches with no reviewer in between,
      // so read is checked when it is made, whatever the setting.
      const creator = await actors.user();
      const other = await actors.user();
      const privateGame = await arrangeGame(creator.user.id, Visibility.Private);
      const publicGame = await arrangeGame(creator.user.id, Visibility.Public);
      const image = await arrangeOwnedImage(other.user.id);

      // An auto-approved contribution hands the media to the service account.
      await new ServiceAccountService(db.client as unknown as DatabaseService).resolveOrEnsure();

      await contribute(other, image.id, privateGame.id).expect(403);
      expect(await db.client.mediaContribution.count({ where: { mediaObjectId: image.id } })).toBe(0);

      // The control: the same media, the same route, a game the contributor reads.
      await contribute(other, image.id, publicGame.id).expect(201);
    });
  });

  describe('searching games', () => {
    it('finds a private game for its creator only', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const token = randomUUID().slice(0, 8);
      const privateGame = await arrangeGame(creator.user.id, Visibility.Private, `Search ${token} private`);
      const publicGame = await arrangeGame(creator.user.id, Visibility.Public, `Search ${token} public`);

      expect((await searchedIds(creator, token, 'the creator')).slice().sort()).toEqual(
        [privateGame.id, publicGame.id].sort(),
      );

      // The control is the Public hit: the search ran and matched for this user.
      expect(await searchedIds(other, token, 'another user')).toEqual([publicGame.id]);
    });
  });
});
