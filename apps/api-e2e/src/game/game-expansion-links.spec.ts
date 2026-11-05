import { ContentType, PlatformType, Reach, ResourceType } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { gameExpansionLinks, listRowBaseGames } from './game-wire';

/**
 * The expansion links the game routes send (#1069), against real rows.
 *
 * `GET /games` rows name an expansion's base games that the actor's list
 * also contains, so a base-game id on a row always means "this game is on
 * some page of your list". `GET /games/:id` names the linked games the actor
 * could open by id. Each is filtered in the `where` of its own read: in an
 * `include` filter Prisma drops a deny-all condition, and a link would name a
 * game the actor may not see.
 *
 * No route writes a link yet: only import does, so links are arranged
 * directly. Every denial below is paired with a control on the same row, so it
 * cannot pass because the links were never there or were sent to no one.
 */
describe('expansion links on the game routes (#1069)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GAMES_PATH = '/api/games';
  // Fresh rows land on page 1 under the newest-first order.
  const LIST_QUERY = 'sort=newest&limit=100';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const token = () => randomUUID().slice(0, 8);

  const arrangeGame = (createdById: string, reach: Reach, title = `e2e game ${token()}`) =>
    db.client.game.create({ data: { title, reach, createdById }, select: { id: true, title: true } });

  const arrangeLink = (baseGameId: string, expansionGameId: string, isStandalone = false) =>
    db.client.gameExpansion.create({ data: { baseGameId, expansionGameId, isStandalone }, select: { id: true } });

  const listRow = async (caller: Caller, gameId: string, who: string) =>
    listRowBaseGames(
      await request(baseUrl).get(`${GAMES_PATH}?${LIST_QUERY}`).set(caller.headers).expect(200),
      gameId,
      `GET ${GAMES_PATH}?${LIST_QUERY} as ${who}`,
    );

  const detail = async (caller: Caller, gameId: string, who: string) =>
    gameExpansionLinks(
      await request(baseUrl).get(`${GAMES_PATH}/${gameId}`).set(caller.headers).expect(200),
      `GET ${GAMES_PATH}/:id as ${who}`,
    );

  const gameIds = (links: readonly { gameId: string }[]) => links.map((link) => link.gameId);

  it('names a base game on a list row and in the detail to its creator, and to no stranger (#1069)', async () => {
    const creator = await actors.user();
    const stranger = await actors.user();
    const privateBase = await arrangeGame(creator.user.id, Reach.Private, `A private base ${token()}`);
    const publicBase = await arrangeGame(creator.user.id, Reach.Public, `B public base ${token()}`);
    const expansion = await arrangeGame(creator.user.id, Reach.Public);
    await arrangeLink(privateBase.id, expansion.id);
    await arrangeLink(publicBase.id, expansion.id);

    // The control: the creator sees both base games on both routes.
    expect(new Set(gameIds(await listRow(creator, expansion.id, 'the creator')))).toEqual(
      new Set([privateBase.id, publicBase.id]),
    );
    expect(gameIds((await detail(creator, expansion.id, 'the creator')).baseGames)).toEqual([
      privateBase.id,
      publicBase.id,
    ]);

    // The stranger sees the same rows with the private base game left out,
    // and the Public one still named, so the links did reach them.
    expect(gameIds(await listRow(stranger, expansion.id, 'a stranger'))).toEqual([publicBase.id]);
    const strangers = await detail(stranger, expansion.id, 'a stranger');
    expect(gameIds(strangers.baseGames)).toEqual([publicBase.id]);
    expect(JSON.stringify(strangers)).not.toContain(privateBase.id);
  });

  it('lists a private expansion on its Public base game’s detail for its creator only (#1069)', async () => {
    const creator = await actors.user();
    const stranger = await actors.user();
    const base = await arrangeGame(creator.user.id, Reach.Public);
    const privateExpansion = await arrangeGame(creator.user.id, Reach.Private, `A private expansion ${token()}`);
    const publicExpansion = await arrangeGame(creator.user.id, Reach.Public, `B public expansion ${token()}`);
    await arrangeLink(base.id, privateExpansion.id);
    await arrangeLink(base.id, publicExpansion.id);

    // The control: the creator gets both, each with its linked game.
    expect((await detail(creator, base.id, 'the creator')).expansions).toEqual([
      {
        gameId: privateExpansion.id,
        isStandalone: false,
        game: {
          id: privateExpansion.id,
          title: privateExpansion.title,
          thumbnail: null,
          contentType: ContentType.BaseGame,
        },
        platformIds: [],
      },
      {
        gameId: publicExpansion.id,
        isStandalone: false,
        game: {
          id: publicExpansion.id,
          title: publicExpansion.title,
          thumbnail: null,
          contentType: ContentType.BaseGame,
        },
        platformIds: [],
      },
    ]);

    expect(gameIds((await detail(stranger, base.id, 'a stranger')).expansions)).toEqual([publicExpansion.id]);
  });

  // The two routes filter by different rules: the detail by what the actor
  // could open by id, the list row by what the actor's list contains. Staff
  // can open a stranger's private game, but it is never in their list (#513),
  // so a list row naming it would point at a game no page will carry.
  it('lets staff see a stranger’s private base game on the detail, which they can open, but not on their list row, which never lists it (#1069)', async () => {
    const creator = await actors.user();
    const admin = await actors.admin();
    const privateBase = await arrangeGame(creator.user.id, Reach.Private);
    const expansion = await arrangeGame(creator.user.id, Reach.Public);
    await arrangeLink(privateBase.id, expansion.id);

    expect(gameIds((await detail(admin, expansion.id, 'an admin')).baseGames)).toEqual([privateBase.id]);
    // The control for the detail: the admin can open the base game itself.
    await request(baseUrl).get(`${GAMES_PATH}/${privateBase.id}`).set(admin.headers).expect(200);

    // The row is there, since the expansion is Public, and names no base game.
    expect(await listRow(admin, expansion.id, 'an admin')).toEqual([]);
    // The control for the list: the creator's row names it.
    expect(gameIds(await listRow(creator, expansion.id, 'the creator'))).toEqual([privateBase.id]);
  });

  it('sends a key without read:platform_game the expansions with no platform ids, and a key with it the ids (#1069)', async () => {
    const keyOwner = await actors.user();
    const base = await arrangeGame(keyOwner.user.id, Reach.Public);
    const expansion = await arrangeGame(keyOwner.user.id, Reach.Public);
    await arrangeLink(base.id, expansion.id);
    const platform = await db.client.platform.create({
      data: { name: `Alpha ${token()}`, slug: `alpha-${token()}`, platformType: PlatformType.Other },
      select: { id: true },
    });
    await db.client.platformGame.create({ data: { gameId: expansion.id, platformId: platform.id } });

    const gameOnly = await mintApiKey(baseUrl, db.client, keyOwner, {
      slugs: ['read:game'],
      resourceType: ResourceType.Game,
    });
    const both = await mintApiKey(baseUrl, db.client, keyOwner, [
      { slugs: ['read:game'], resourceType: ResourceType.Game },
      { slugs: ['read:platform_game'], resourceType: ResourceType.PlatformGame },
    ]);

    const withoutIds = (await detail(gameOnly, base.id, 'a key holding read:game alone')).expansions;
    expect(withoutIds.map(({ gameId, platformIds }) => ({ gameId, platformIds }))).toEqual([
      { gameId: expansion.id, platformIds: [] },
    ]);

    // The control: the same key owner's key holding both gets the id, so the
    // empty list above comes from the missing key scope.
    const withIds = (await detail(both, base.id, 'a key holding both')).expansions;
    expect(withIds.map(({ gameId, platformIds }) => ({ gameId, platformIds }))).toEqual([
      { gameId: expansion.id, platformIds: [platform.id] },
    ]);
  });

  // The schema keeps `isStandalone` on the link, so an expansion can be
  // standalone for one base game and not another. Neither route may merge them.
  it('keeps each link’s isStandalone when an expansion attaches to two base games (#1069)', async () => {
    const creator = await actors.user();
    const standaloneFor = await arrangeGame(creator.user.id, Reach.Public, `A base ${token()}`);
    const notStandaloneFor = await arrangeGame(creator.user.id, Reach.Public, `B base ${token()}`);
    const expansion = await arrangeGame(creator.user.id, Reach.Public);
    await arrangeLink(standaloneFor.id, expansion.id, true);
    await arrangeLink(notStandaloneFor.id, expansion.id, false);

    const expected = [
      { gameId: standaloneFor.id, isStandalone: true },
      { gameId: notStandaloneFor.id, isStandalone: false },
    ];

    expect(await listRow(creator, expansion.id, 'the creator')).toEqual(expected);

    const { baseGames } = await detail(creator, expansion.id, 'the creator');
    expect(baseGames.map(({ gameId, isStandalone }) => ({ gameId, isStandalone }))).toEqual(expected);

    const fromStandalone = (await detail(creator, standaloneFor.id, 'the creator')).expansions;
    expect(fromStandalone.map(({ gameId, isStandalone }) => ({ gameId, isStandalone }))).toEqual([
      { gameId: expansion.id, isStandalone: true },
    ]);
    const fromOther = (await detail(creator, notStandaloneFor.id, 'the creator')).expansions;
    expect(fromOther.map(({ gameId, isStandalone }) => ({ gameId, isStandalone }))).toEqual([
      { gameId: expansion.id, isStandalone: false },
    ]);
  });

  // Created in the opposite order to the one expected, so a read in creation
  // order fails. Two share a title, so the game id has to decide between them.
  // A list row gives an expansion's base games in the detail's order.
  it('orders the detail lists and a list row’s base games by title, then game id (#1069)', async () => {
    const creator = await actors.user();
    const t = token();
    const base = await arrangeGame(creator.user.id, Reach.Public, `B base ${t}`);
    const zeta = await arrangeGame(creator.user.id, Reach.Public, `Zeta ${t}`);
    const tiedA = await arrangeGame(creator.user.id, Reach.Public, `Alpha ${t}`);
    const tiedB = await arrangeGame(creator.user.id, Reach.Public, `Alpha ${t}`);
    for (const expansion of [zeta, tiedA, tiedB]) {
      await arrangeLink(base.id, expansion.id);
    }

    const otherBase = await arrangeGame(creator.user.id, Reach.Public, `A base ${t}`);
    await arrangeLink(otherBase.id, zeta.id);

    expect(gameIds((await detail(creator, base.id, 'the creator')).expansions)).toEqual([
      ...[tiedA.id, tiedB.id].sort(),
      zeta.id,
    ]);
    expect(gameIds((await detail(creator, zeta.id, 'the creator')).baseGames)).toEqual([otherBase.id, base.id]);
    expect(gameIds(await listRow(creator, zeta.id, 'the creator'))).toEqual([otherBase.id, base.id]);
  });

  // Staff read every game unconditioned, a soft-deleted one included, so the
  // detail's links test liveness themselves: a soft-deleted game is never
  // offered as an expansion to get, as `GET /games` never lists it. Each
  // denial is the same link the admin was shown before the game was deleted.
  it('names no soft-deleted game in the detail lists, even to staff (#1069)', async () => {
    const creator = await actors.user();
    const admin = await actors.admin();
    const base = await arrangeGame(creator.user.id, Reach.Public);
    const expansion = await arrangeGame(creator.user.id, Reach.Public);
    await arrangeLink(base.id, expansion.id);

    expect(gameIds((await detail(admin, base.id, 'an admin')).expansions)).toEqual([expansion.id]);
    expect(gameIds((await detail(admin, expansion.id, 'an admin')).baseGames)).toEqual([base.id]);

    const softDelete = (id: string) => db.client.game.update({ where: { id }, data: { deletedAt: new Date() } });

    await softDelete(expansion.id);
    expect((await detail(admin, base.id, 'an admin')).expansions).toEqual([]);

    await db.client.game.update({ where: { id: expansion.id }, data: { deletedAt: null } });
    await softDelete(base.id);
    expect((await detail(admin, expansion.id, 'an admin')).baseGames).toEqual([]);
  });

  // The parsers fail on an absent list, so this holds only if each list is
  // present and empty.
  it('sends baseGames: [] on a game that is no expansion, and empty detail lists on a game with no links (#1069)', async () => {
    const creator = await actors.user();
    const game = await arrangeGame(creator.user.id, Reach.Public);

    expect(await listRow(creator, game.id, 'the creator')).toEqual([]);
    expect(await detail(creator, game.id, 'the creator')).toEqual({ expansions: [], baseGames: [] });
  });
});
