import { ContentType, PlatformType, Reach, ResourceType } from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { tabletopPlatform } from '../support/seeded-platforms';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import type { ExpansionLinkWire } from './game-wire';
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

  const arrangeGame = (createdById: string, reach: Reach, title = `e2e game ${token()}`, contentType?: ContentType) =>
    db.client.game.create({ data: { title, reach, createdById, contentType }, select: { id: true, title: true } });

  const arrangeLink = (baseGameId: string, expansionGameId: string) =>
    db.client.gameExpansion.create({ data: { baseGameId, expansionGameId }, select: { id: true } });

  // Platforms are shared by every spec, so each name carries the caller's token.
  const arrangePlatform = (name: string, platformType: PlatformType) =>
    db.client.platform.create({
      data: { name, slug: name.toLowerCase().replace(/\s+/g, '-'), platformType },
      select: { id: true },
    });

  const arrangePlatformGame = (gameId: string, platformId: string) =>
    db.client.platformGame.create({ data: { gameId, platformId }, select: { id: true } });

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

  const platformIdsOf = (links: readonly { gameId: string; platformIds: readonly string[] }[]) =>
    links.map(({ gameId, platformIds }) => ({ gameId, platformIds }));

  it('names a base game on a list row and in the detail to its creator, and to no stranger (#1069)', async () => {
    const creator = await actors.user();
    const stranger = await actors.user();
    const privateBase = await arrangeGame(creator.user.id, Reach.Private, `A private base ${token()}`);
    const publicBase = await arrangeGame(creator.user.id, Reach.Public, `B public base ${token()}`);
    const expansion = await arrangeGame(creator.user.id, Reach.Public, undefined, ContentType.Expansion);
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
    const privateExpansion = await arrangeGame(
      creator.user.id,
      Reach.Private,
      `A private expansion ${token()}`,
      ContentType.Expansion,
    );
    const publicExpansion = await arrangeGame(
      creator.user.id,
      Reach.Public,
      `B public expansion ${token()}`,
      ContentType.Expansion,
    );
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
          contentType: ContentType.Expansion,
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
          contentType: ContentType.Expansion,
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
    const expansion = await arrangeGame(creator.user.id, Reach.Public, undefined, ContentType.Expansion);
    await arrangeLink(privateBase.id, expansion.id);

    expect(gameIds((await detail(admin, expansion.id, 'an admin')).baseGames)).toEqual([privateBase.id]);
    // The control for the detail: the admin can open the base game itself.
    await request(baseUrl).get(`${GAMES_PATH}/${privateBase.id}`).set(admin.headers).expect(200);

    // The row is there, since the expansion is Public, and names no base game.
    expect(await listRow(admin, expansion.id, 'an admin')).toEqual([]);
    // The control for the list: the creator's row names it.
    expect(gameIds(await listRow(creator, expansion.id, 'the creator'))).toEqual([privateBase.id]);
  });

  // A key with no `read:platform_game` reads no platform game at either end
  // of a link, so each link holds on no platform it can see. Nothing reads
  // around the ceiling to fill them in (#1391).
  it('sends a key without read:platform_game links with no platform ids at either end, and a key with it the ids (#1069, #1391)', async () => {
    const keyOwner = await actors.user();
    const base = await arrangeGame(keyOwner.user.id, Reach.Public);
    const expansion = await arrangeGame(keyOwner.user.id, Reach.Public, undefined, ContentType.Expansion);
    await arrangeLink(base.id, expansion.id);
    // Both games are on the platform, so the link holds on it.
    const platform = await arrangePlatform(`Alpha ${token()}`, PlatformType.Other);
    await arrangePlatformGame(base.id, platform.id);
    await arrangePlatformGame(expansion.id, platform.id);

    const gameOnly = await mintApiKey(baseUrl, db.client, keyOwner, {
      slugs: ['read:game'],
      resourceType: ResourceType.Game,
    });
    const both = await mintApiKey(baseUrl, db.client, keyOwner, [
      { slugs: ['read:game'], resourceType: ResourceType.Game },
      { slugs: ['read:platform_game'], resourceType: ResourceType.PlatformGame },
    ]);

    const gameOnlyCaller = 'a key holding read:game alone';
    expect(platformIdsOf((await detail(gameOnly, base.id, gameOnlyCaller)).expansions)).toEqual([
      { gameId: expansion.id, platformIds: [] },
    ]);
    expect(platformIdsOf((await detail(gameOnly, expansion.id, gameOnlyCaller)).baseGames)).toEqual([
      { gameId: base.id, platformIds: [] },
    ]);

    // The control: the same key owner's key holding both gets the id at
    // either end, so the empty lists above come from the missing key scope.
    expect(platformIdsOf((await detail(both, base.id, 'a key holding both')).expansions)).toEqual([
      { gameId: expansion.id, platformIds: [platform.id] },
    ]);
    expect(platformIdsOf((await detail(both, expansion.id, 'a key holding both')).baseGames)).toEqual([
      { gameId: base.id, platformIds: [platform.id] },
    ]);
  });

  // An add-on link holds on the platforms both its games are on: a base game
  // on Tabletop and PC with an expansion on PC and Mac holds on PC alone, and
  // the link says so from either end.
  it('makes an add-on link’s platformIds the platforms both games are on, from either end (#1391)', async () => {
    const creator = await actors.user();
    const t = token();
    const tabletop = await tabletopPlatform(db.client);
    const pc = await arrangePlatform(`PC ${t}`, PlatformType.PC);
    const mac = await arrangePlatform(`Mac ${t}`, PlatformType.PC);
    const base = await arrangeGame(creator.user.id, Reach.Public, `Base ${t}`);
    const expansion = await arrangeGame(creator.user.id, Reach.Public, `Expansion ${t}`, ContentType.Expansion);
    await arrangePlatformGame(base.id, tabletop.id);
    await arrangePlatformGame(base.id, pc.id);
    await arrangePlatformGame(expansion.id, pc.id);
    await arrangePlatformGame(expansion.id, mac.id);
    await arrangeLink(base.id, expansion.id);

    expect(platformIdsOf((await detail(creator, base.id, 'the creator')).expansions)).toEqual([
      { gameId: expansion.id, platformIds: [pc.id] },
    ]);
    expect(platformIdsOf((await detail(creator, expansion.id, 'the creator')).baseGames)).toEqual([
      { gameId: base.id, platformIds: [pc.id] },
    ]);
  });

  // A link that holds on no platform is still a link: the DLC is listed under
  // its base game, from either end, with no platform to play it on. The
  // expansion on Tabletop beside it is the control: the same base game and
  // the same reads, on a platform both games are on.
  it('lists a DLC only on PC under a Tabletop-only base game with empty platformIds (#1391)', async () => {
    const creator = await actors.user();
    const t = token();
    const tabletop = await tabletopPlatform(db.client);
    const pc = await arrangePlatform(`PC ${t}`, PlatformType.PC);
    const base = await arrangeGame(creator.user.id, Reach.Public, `Base ${t}`);
    const dlc = await arrangeGame(creator.user.id, Reach.Public, `A DLC ${t}`, ContentType.DLC);
    const expansion = await arrangeGame(creator.user.id, Reach.Public, `B expansion ${t}`, ContentType.Expansion);
    await arrangePlatformGame(base.id, tabletop.id);
    await arrangePlatformGame(dlc.id, pc.id);
    await arrangePlatformGame(expansion.id, tabletop.id);
    await arrangeLink(base.id, dlc.id);
    await arrangeLink(base.id, expansion.id);

    expect(platformIdsOf((await detail(creator, base.id, 'the creator')).expansions)).toEqual([
      { gameId: dlc.id, platformIds: [] },
      { gameId: expansion.id, platformIds: [tabletop.id] },
    ]);
    expect(platformIdsOf((await detail(creator, dlc.id, 'the creator')).baseGames)).toEqual([
      { gameId: base.id, platformIds: [] },
    ]);
  });

  // `isStandalone` is the add-on's, from its content type, so it reads the
  // same on every link of the add-on and from either end. The DLC beside it
  // is the control: the same two base games, `false` on every link.
  it('makes an add-on that is a standalone expansion standalone on every link (#1391)', async () => {
    const creator = await actors.user();
    const t = token();
    const firstBase = await arrangeGame(creator.user.id, Reach.Public, `A base ${t}`);
    const secondBase = await arrangeGame(creator.user.id, Reach.Public, `B base ${t}`);
    const standalone = await arrangeGame(
      creator.user.id,
      Reach.Public,
      `A standalone ${t}`,
      ContentType.StandaloneExpansion,
    );
    const dlc = await arrangeGame(creator.user.id, Reach.Public, `B DLC ${t}`, ContentType.DLC);
    for (const addOn of [standalone, dlc]) {
      await arrangeLink(firstBase.id, addOn.id);
      await arrangeLink(secondBase.id, addOn.id);
    }

    const pick = (links: readonly ExpansionLinkWire[]) =>
      links.map(({ gameId, isStandalone }) => ({ gameId, isStandalone }));

    for (const [addOn, isStandalone] of [
      [standalone, true],
      [dlc, false],
    ] as const) {
      const expected = [
        { gameId: firstBase.id, isStandalone },
        { gameId: secondBase.id, isStandalone },
      ];

      expect(await listRow(creator, addOn.id, 'the creator')).toEqual(expected);
      expect(pick((await detail(creator, addOn.id, 'the creator')).baseGames)).toEqual(expected);
    }

    for (const base of [firstBase, secondBase]) {
      expect(pick((await detail(creator, base.id, 'the creator')).expansions)).toEqual([
        { gameId: standalone.id, isStandalone: true },
        { gameId: dlc.id, isStandalone: false },
      ]);
    }
  });

  // Created in the opposite order to the one expected, so a read in creation
  // order fails. Two share a title, so the game id has to decide between them.
  // A list row gives an expansion's base games in the detail's order.
  it('orders the detail lists and a list row’s base games by title, then game id (#1069)', async () => {
    const creator = await actors.user();
    const t = token();
    const base = await arrangeGame(creator.user.id, Reach.Public, `B base ${t}`);
    const zeta = await arrangeGame(creator.user.id, Reach.Public, `Zeta ${t}`, ContentType.Expansion);
    const tiedA = await arrangeGame(creator.user.id, Reach.Public, `Alpha ${t}`, ContentType.Expansion);
    const tiedB = await arrangeGame(creator.user.id, Reach.Public, `Alpha ${t}`, ContentType.Expansion);
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
    const expansion = await arrangeGame(creator.user.id, Reach.Public, undefined, ContentType.Expansion);
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

  // Only an add-on gets a link (#1391). A re-import that makes a game no
  // add-on keeps its link to a base game its DataGateway no longer names, as
  // no link records where it came from (#1178). Neither route lists it, at
  // either end. The control turns the same game into a DLC, and the same
  // stored link is listed on both.
  it('lists a stored link of a game that is no add-on at neither end, on neither route (#1391)', async () => {
    const creator = await actors.user();
    const base = await arrangeGame(creator.user.id, Reach.Public);
    const remaster = await arrangeGame(creator.user.id, Reach.Public, undefined, ContentType.Remaster);
    await arrangeLink(base.id, remaster.id);

    expect((await detail(creator, base.id, 'the creator')).expansions).toEqual([]);
    expect((await detail(creator, remaster.id, 'the creator')).baseGames).toEqual([]);
    expect(await listRow(creator, remaster.id, 'the creator')).toEqual([]);

    await db.client.game.update({ where: { id: remaster.id }, data: { contentType: ContentType.DLC } });

    expect(gameIds((await detail(creator, base.id, 'the creator')).expansions)).toEqual([remaster.id]);
    expect(gameIds((await detail(creator, remaster.id, 'the creator')).baseGames)).toEqual([base.id]);
    expect(gameIds(await listRow(creator, remaster.id, 'the creator'))).toEqual([base.id]);
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
