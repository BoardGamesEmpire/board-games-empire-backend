import { Reach, type DatabaseService } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { befriend, createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameEnvelope, listGamesEnvelope, localSearchGameIds } from './game-wire';

/**
 * Who may read and change a game (#472, #491), against real rows.
 *
 * A game carries a reach its creator chooses. A Public game is everyone's
 * to read; a Friends one is its creator's and their friends'; a Private one is
 * its creator's. Staff read each by id through `read:public_content`, and the
 * Owner through `manage:all`. The list and the search show every acting user
 * the same set: the Public games, their own, and their friends' that reach
 * friends (#513, #809). Before #472 `read:game` carried no condition, so every
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

  const arrangeGame = (createdById: string, reach: Reach, title = `e2e game ${randomUUID().slice(0, 8)}`) =>
    db.client.game.create({ data: { title, reach, createdById }, select: { id: true } });

  /**
   * A game as an import leaves it: owned by the service account and Public.
   * The account is ensured the way the import path ensures it, rather than
   * waited for: provisioning creates it only after the Owner's roles land.
   */
  const arrangeImportedGame = async () => {
    const serviceAccount = await new ServiceAccountService(db.client as unknown as DatabaseService).resolveOrEnsure();

    return arrangeGame(serviceAccount.id, Reach.Public);
  };

  const reachOf = async (id: string) =>
    (await db.client.game.findUniqueOrThrow({ where: { id }, select: { reach: true } })).reach;

  describe('reading a game', () => {
    it('serves a private game to its creator and to no other user, by id and in the list', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const privateGame = await arrangeGame(creator.user.id, Reach.Private);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public);

      expect((await listedIds(creator, 'the creator')).sort()).toEqual([privateGame.id, publicGame.id].sort());
      await readGame(creator, privateGame.id).expect(200);

      // The control: the other user reads the creator's Public game, so the
      // denials after it are about the private row, not the route.
      expect(await listedIds(other, 'another user')).toEqual([publicGame.id]);
      await readGame(other, publicGame.id).expect(200);

      // The game is there and the caller may not see it: 403, as for households.
      await readGame(other, privateGame.id).expect(403);
    });

    it('lists staff no stranger’s private game, while each still reads it by id', async () => {
      const [serverOwner, admin, moderator, creator, plainUser] = await Promise.all([
        actors.owner(),
        actors.admin(),
        actors.moderator(),
        actors.user(),
        actors.user(),
      ]);

      const privateGame = await arrangeGame(creator.user.id, Reach.Private);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public);

      const staff = [
        ['an admin', admin],
        ['a moderator', moderator],
        ["the server's Owner", serverOwner],
      ] as const;

      // The control. Admin and Moderator read the stranger's private game
      // through `read:public_content`, and the Owner through `manage:all`. A
      // plain user is refused the same game, so the reads come from the staff
      // grants and not from the game being open to everyone.
      for (const [who, actor] of staff) {
        const read = await readGame(actor, privateGame.id).expect(200);
        expect(gameEnvelope(read, `GET /api/games/:id as ${who}`).game.id).toBe(privateGame.id);
      }
      await readGame(plainUser, privateGame.id).expect(403);

      // The list is the Public games and the caller's own, whoever asks
      // (#513). Before, it was everything the caller could read by id.
      for (const [who, actor] of staff) {
        const page = listGamesEnvelope(await listGames(actor).expect(200), `GET /api/games as ${who}`);
        expect(page.games.map((game) => game.id)).toEqual([publicGame.id]);
        expect(page.total).toBe(1);
      }
    });

    it('refuses an anonymous guest both routes, Public games included', async () => {
      // `AnonymousUser` holds no game read at all (#484), so the guard refuses
      // before a row is read.
      const creator = await actors.user();
      const publicGame = await arrangeGame(creator.user.id, Reach.Public);
      const guest = await actors.anonymous();

      await readGame(creator, publicGame.id).expect(200);

      await listGames(guest).expect(403);
      await readGame(guest, publicGame.id).expect(403);
    });
  });

  describe("a friend's game", () => {
    it('serves a friend a Friends game by id, in the list and in search, and refuses a stranger all three', async () => {
      const creator = await actors.user();
      const friend = await actors.user();
      const stranger = await actors.user();
      await befriend(db.client, friend, creator);
      const token = randomUUID().slice(0, 8);
      const game = await arrangeGame(creator.user.id, Reach.Friends, `e2e friends ${token}`);

      await readGame(friend, game.id).expect(200);
      expect(await listedIds(friend, 'a friend')).toContain(game.id);
      expect(await searchedIds(friend, token, 'a friend')).toContain(game.id);

      // The control for the list and the search is the friend's hits above:
      // the same routes, the same row.
      await readGame(stranger, game.id).expect(403);
      expect(await listedIds(stranger, 'a stranger')).not.toContain(game.id);
      expect(await searchedIds(stranger, token, 'a stranger')).not.toContain(game.id);
    });

    // The list names the friendship itself, so staff, who read every game,
    // are still listed only their own friends' games.
    it('lists staff no stranger’s Friends game, while each still reads it by id', async () => {
      const [serverOwner, admin, moderator, creator, plainUser] = await Promise.all([
        actors.owner(),
        actors.admin(),
        actors.moderator(),
        actors.user(),
        actors.user(),
      ]);

      const friendsGame = await arrangeGame(creator.user.id, Reach.Friends);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public);

      const staff = [
        ['an admin', admin],
        ['a moderator', moderator],
        ["the server's Owner", serverOwner],
      ] as const;

      for (const [who, actor] of staff) {
        await readGame(actor, friendsGame.id).expect(200);
        expect(await listedIds(actor, who)).toEqual([publicGame.id]);
      }

      // The control: a plain user is refused the same game, so the staff
      // reads come from the staff grants.
      await readGame(plainUser, friendsGame.id).expect(403);
    });

    it('lists staff their own friends’ Friends games', async () => {
      const [serverOwner, admin, moderator, creator] = await Promise.all([
        actors.owner(),
        actors.admin(),
        actors.moderator(),
        actors.user(),
      ]);

      const staff = [
        ['an admin', admin],
        ['a moderator', moderator],
        ["the server's Owner", serverOwner],
      ] as const;

      await Promise.all(staff.map(([, actor]) => befriend(db.client, actor, creator)));
      const friendsGame = await arrangeGame(creator.user.id, Reach.Friends);

      for (const [who, actor] of staff) {
        expect(await listedIds(actor, who)).toContain(friendsGame.id);
      }
    });
  });

  describe('creating a game', () => {
    it('keeps the reach it was sent, so a private game is its creator’s alone', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const created = await createGame(creator, { title: 'Private prototype', reach: Reach.Private }).expect(201);
      const { game } = gameEnvelope(created, 'POST /api/games');

      expect(game.reach).toBe(Reach.Private);
      expect(game.createdById).toBe(creator.user.id);

      await readGame(creator, game.id).expect(200);
      await readGame(other, game.id).expect(403);
    });

    it('keeps Friends when a game is created with it', async () => {
      const creator = await actors.user();

      const created = await createGame(creator, { title: 'Friends prototype', reach: Reach.Friends }).expect(201);
      const { game } = gameEnvelope(created, 'POST /api/games with reach Friends');

      expect(game.reach).toBe(Reach.Friends);
      expect(await reachOf(game.id)).toBe(Reach.Friends);
    });

    it.each([Reach.FriendsOfFriends])(
      'refuses %s with 400 — no game read rule honours it until #496',
      async (reach) => {
        const creator = await actors.user();

        await createGame(creator, { title: 'Tiered prototype', reach }).expect(400);
      },
    );

    it('refuses Household with 400, which is no longer a reach (#808)', async () => {
      const creator = await actors.user();

      await createGame(creator, { title: 'Household prototype', reach: 'Household' }).expect(400);
    });

    it('refuses the old `visible` field with 400 rather than failing inside Prisma', async () => {
      // #491: the DTO declared `visible`, which is not a Game column, so the
      // spread into `game.create` failed as a 500.
      const creator = await actors.user();

      await createGame(creator, { title: 'Misnamed prototype', visible: Reach.Private }).expect(400);
    });

    it('refuses an explicit null reach with 400 on create and on update', async () => {
      // The column is not nullable, so a null that got past validation would
      // fail inside Prisma as a 500.
      const creator = await actors.user();
      const game = await arrangeGame(creator.user.id, Reach.Public);

      await createGame(creator, { title: 'Null prototype', reach: null }).expect(400);
      await updateGame(creator, game.id, { reach: null }).expect(400);
      expect(await reachOf(game.id)).toBe(Reach.Public);
    });
  });

  describe('updating a game', () => {
    it('lets the creator make their game private, and refuses anyone else with 403', async () => {
      const creator = await actors.user();
      const other = await actors.user();

      const game = await arrangeGame(creator.user.id, Reach.Public);

      await updateGame(other, game.id, { reach: Reach.Private }).expect(403);
      expect(await reachOf(game.id)).toBe(Reach.Public);

      await updateGame(creator, game.id, { reach: Reach.Private }).expect(200);
      expect(await reachOf(game.id)).toBe(Reach.Private);

      await readGame(other, game.id).expect(403);
    });

    it.each([Reach.Private, Reach.Friends])(
      'refuses to narrow an imported game to %s, even for an admin',
      async (reach) => {
        // Re-import never rewrites reach, so an imported game narrowed here
        // would stay narrowed for good.
        const admin = await actors.admin();
        const user = await actors.user();
        const imported = await arrangeImportedGame();

        await updateGame(admin, imported.id, { reach }).expect(400);
        expect(await reachOf(imported.id)).toBe(Reach.Public);

        // The control: the admin may edit the game, just not narrow it.
        await updateGame(admin, imported.id, { title: 'Renamed import' }).expect(200);

        // A user who may not edit it at all hears that, not the rule above.
        await updateGame(user, imported.id, { reach }).expect(403);
      },
    );
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
      const privateGame = await arrangeGame(creator.user.id, Reach.Private);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public);
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
      const privateGame = await arrangeGame(creator.user.id, Reach.Private, `Search ${token} private`);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public, `Search ${token} public`);

      expect((await searchedIds(creator, token, 'the creator')).slice().sort()).toEqual(
        [privateGame.id, publicGame.id].sort(),
      );

      // The control is the Public hit: the search ran and matched for this user.
      expect(await searchedIds(other, token, 'another user')).toEqual([publicGame.id]);
    });

    it('finds an admin a stranger’s Public game and not their private one', async () => {
      const creator = await actors.user();
      const admin = await actors.admin();

      const token = randomUUID().slice(0, 8);
      const privateGame = await arrangeGame(creator.user.id, Reach.Private, `Search ${token} private`);
      const publicGame = await arrangeGame(creator.user.id, Reach.Public, `Search ${token} public`);

      // The admin reads the private game by id, so the search leaving it out
      // is the search's scope (#513), not a missing grant.
      await readGame(admin, privateGame.id).expect(200);

      // The control is the Public hit: the search ran and matched for the admin.
      expect(await searchedIds(admin, token, 'an admin')).toEqual([publicGame.id]);
    });
  });
});
