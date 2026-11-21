import { AuthType, ContentType, PlatformType, Reach } from '@bge/database';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { tabletopPlatform } from '../support/seeded-platforms';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import type { GameLinksWire } from './game-wire';
import { gameExpansionLinks, gameLinks } from './game-wire';

/**
 * The works-with links (#1392), contents links and bundles (#1394) of
 * `GET /games/:id`, against real rows.
 *
 * No table stores these links: a link holds when either game's DataGateway
 * link names the other's external id on the same DataGateway. So the rows
 * arranged here are what an import stores, a DataGateway link with its
 * external ids, and each test arranges a DataGateway of its own. Which ids
 * BoardGameGeek and IGDB send is the mapper tests' concern.
 *
 * Every denial below is paired with a control on the same response, so it
 * cannot pass because the links were never there or were sent to no one.
 */
describe('works-with links, contents and bundles on the game detail (#1392, #1394)', () => {
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

  const token = () => randomUUID().slice(0, 8);

  const arrangeGame = (createdById: string, reach: Reach, title: string, contentType?: ContentType) =>
    db.client.game.create({
      data: { title, reach, createdById, contentType },
      select: { id: true, title: true, contentType: true },
    });

  // DataGateway names are unique across every spec, so each carries a token.
  // Disabled, so nothing reaches for a coordinator over it.
  const arrangeGateway = (name: string) =>
    db.client.dataGateway.create({
      data: {
        name: `${name} ${token()}`,
        connectionUrl: 'localhost',
        connectionPort: 50099,
        authType: AuthType.None,
        enabled: false,
      },
      select: { id: true },
    });

  interface NamedIds {
    readonly bundleExternalIds?: string[];
    readonly contentExternalIds?: string[];
    readonly worksWithExternalIds?: string[];
  }

  /** The DataGateway link an import leaves on `gameId`, naming the games the DataGateway sent beside it. */
  const arrangeDataGatewayLink = (gameId: string, gatewayId: string, externalId: string, named: NamedIds = {}) =>
    db.client.gameSource.create({ data: { gameId, gatewayId, externalId, ...named }, select: { id: true } });

  const arrangePlatform = (name: string, platformType: PlatformType) =>
    db.client.platform.create({
      data: { name, slug: name.toLowerCase().replace(/\s+/g, '-'), platformType },
      select: { id: true },
    });

  const arrangePlatformGame = (gameId: string, platformId: string) =>
    db.client.platformGame.create({ data: { gameId, platformId }, select: { id: true } });

  const readDetail = async (caller: Caller, gameId: string) =>
    request(baseUrl).get(`${GAMES_PATH}/${gameId}`).set(caller.headers).expect(200);

  const detail = async (caller: Caller, gameId: string, who: string): Promise<GameLinksWire> =>
    gameLinks(await readDetail(caller, gameId), `GET ${GAMES_PATH}/:id as ${who}`);

  const gameIds = (links: readonly { gameId: string }[]) => links.map((link) => link.gameId);

  // The whole entry for a linked game that is not a standalone expansion, so
  // its `isStandalone` is false. The platforms test sends a true one.
  const linkTo = (game: { contentType: ContentType; id: string; title: string }) => ({
    gameId: game.id,
    isStandalone: false,
    game: { id: game.id, title: game.title, thumbnail: null, contentType: game.contentType },
    platformIds: [],
  });

  describe('works-with links', () => {
    // Horizons of Spirit Island and Spirit Island, two base games played
    // together. Each DataGateway link names the other only if `named` says so.
    const arrangeSpiritIsland = async (named: { readonly byHorizons: boolean; readonly bySpiritIsland: boolean }) => {
      const creator = await actors.user();
      const t = token();
      const gateway = await arrangeGateway('Works-with gateway');
      const horizons = await arrangeGame(creator.user.id, Reach.Public, `Horizons of Spirit Island ${t}`);
      const spiritIsland = await arrangeGame(creator.user.id, Reach.Public, `Spirit Island ${t}`);
      await arrangeDataGatewayLink(horizons.id, gateway.id, '298047', {
        worksWithExternalIds: named.byHorizons ? ['162886'] : [],
      });
      await arrangeDataGatewayLink(spiritIsland.id, gateway.id, '162886', {
        worksWithExternalIds: named.bySpiritIsland ? ['298047'] : [],
      });

      return { creator, horizons, spiritIsland };
    };

    it('links Horizons of Spirit Island and Spirit Island when only Horizons names the other (#1392)', async () => {
      const { creator, horizons, spiritIsland } = await arrangeSpiritIsland({
        byHorizons: true,
        bySpiritIsland: false,
      });

      expect(await detail(creator, horizons.id, 'the creator')).toEqual({
        worksWith: [linkTo(spiritIsland)],
        contents: [],
        bundles: [],
      });
      expect(await detail(creator, spiritIsland.id, 'the creator')).toEqual({
        worksWith: [linkTo(horizons)],
        contents: [],
        bundles: [],
      });
    });

    // Whichever of the two is imported first, the second names the first.
    it('links them the same when only Spirit Island names Horizons (#1392)', async () => {
      const { creator, horizons, spiritIsland } = await arrangeSpiritIsland({
        byHorizons: false,
        bySpiritIsland: true,
      });

      expect(await detail(creator, horizons.id, 'the creator')).toEqual({
        worksWith: [linkTo(spiritIsland)],
        contents: [],
        bundles: [],
      });
      expect(await detail(creator, spiritIsland.id, 'the creator')).toEqual({
        worksWith: [linkTo(horizons)],
        contents: [],
        bundles: [],
      });
    });

    // Both arms of the read match the same game row, which is listed once.
    it('lists a pair once when both name each other (#1392)', async () => {
      const { creator, horizons, spiritIsland } = await arrangeSpiritIsland({ byHorizons: true, bySpiritIsland: true });

      expect(gameIds((await detail(creator, horizons.id, 'the creator')).worksWith)).toEqual([spiritIsland.id]);
      expect(gameIds((await detail(creator, spiritIsland.id, 'the creator')).worksWith)).toEqual([horizons.id]);
    });

    // A works-with link names neither game the base game, so it is no add-on
    // link, even when one end is an add-on. Branch & Claw, an expansion of
    // Spirit Island, works with Horizons. Both ends' add-on lists are read, as
    // Branch & Claw is an add-on, and neither drops it for its content type,
    // so a works-with game merged into either would show. Each absence sits
    // beside a real add-on link in the same response: Spirit Island among
    // Branch & Claw's base games, and Horizons' own expansion among its
    // expansions.
    it('never lists a works-with game in expansions or baseGames (#1392)', async () => {
      const creator = await actors.user();
      const t = token();
      const gateway = await arrangeGateway('Works-with add-on gateway');
      const spiritIsland = await arrangeGame(creator.user.id, Reach.Public, `Spirit Island ${t}`);
      const horizons = await arrangeGame(creator.user.id, Reach.Public, `Horizons of Spirit Island ${t}`);
      const branchAndClaw = await arrangeGame(
        creator.user.id,
        Reach.Public,
        `Branch & Claw ${t}`,
        ContentType.Expansion,
      );
      const horizonsExpansion = await arrangeGame(
        creator.user.id,
        Reach.Public,
        `An expansion of Horizons ${t}`,
        ContentType.Expansion,
      );
      await db.client.gameExpansion.create({
        data: { baseGameId: spiritIsland.id, expansionGameId: branchAndClaw.id },
      });
      await db.client.gameExpansion.create({
        data: { baseGameId: horizons.id, expansionGameId: horizonsExpansion.id },
      });
      await arrangeDataGatewayLink(branchAndClaw.id, gateway.id, '1', { worksWithExternalIds: ['2'] });
      await arrangeDataGatewayLink(horizons.id, gateway.id, '2');

      const branchAndClawResponse = await readDetail(creator, branchAndClaw.id);
      const branchAndClawRequest = `GET ${GAMES_PATH}/:id of Branch & Claw as the creator`;
      expect(gameIds(gameLinks(branchAndClawResponse, branchAndClawRequest).worksWith)).toEqual([horizons.id]);
      expect(gameIds(gameExpansionLinks(branchAndClawResponse, branchAndClawRequest).baseGames)).toEqual([
        spiritIsland.id,
      ]);

      const horizonsResponse = await readDetail(creator, horizons.id);
      const horizonsRequest = `GET ${GAMES_PATH}/:id of Horizons as the creator`;
      expect(gameIds(gameLinks(horizonsResponse, horizonsRequest).worksWith)).toEqual([branchAndClaw.id]);
      expect(gameIds(gameExpansionLinks(horizonsResponse, horizonsRequest).expansions)).toEqual([horizonsExpansion.id]);
    });

    // BoardGameGeek and IGDB number their items independently, so the same
    // external id on two DataGateways is two unrelated items. Each arm of the
    // read has a control on the right DataGateway: Spirit Island, which
    // Horizons names, and Catan, which names Horizons.
    it('does not link the same external id on another DataGateway (#1392)', async () => {
      const creator = await actors.user();
      const t = token();
      const right = await arrangeGateway('Right gateway');
      const other = await arrangeGateway('Other gateway');
      const game = (title: string) => arrangeGame(creator.user.id, Reach.Public, `${title} ${t}`);

      const horizons = await game('Horizons of Spirit Island');
      const spiritIsland = await game('Spirit Island');
      const catan = await game('Catan');
      const sameIdAsSpiritIsland = await game('A game numbered as Spirit Island elsewhere');
      const namingHorizonsId = await game('A game naming the id of Horizons elsewhere');
      const sameIdAsHorizons = await game('A game numbered as Horizons elsewhere');

      await arrangeDataGatewayLink(horizons.id, right.id, '13', { worksWithExternalIds: ['14'] });
      await arrangeDataGatewayLink(spiritIsland.id, right.id, '14');
      await arrangeDataGatewayLink(catan.id, right.id, '15', { worksWithExternalIds: ['13'] });
      await arrangeDataGatewayLink(sameIdAsSpiritIsland.id, other.id, '14');
      await arrangeDataGatewayLink(namingHorizonsId.id, other.id, '16', { worksWithExternalIds: ['13'] });
      await arrangeDataGatewayLink(sameIdAsHorizons.id, other.id, '13');

      const horizonsLinks = await detail(creator, horizons.id, 'the creator');
      expect(gameIds(horizonsLinks.worksWith)).toEqual([catan.id, spiritIsland.id]);

      // From the other DataGateway's side: the game naming `13` there is
      // linked to that DataGateway's `13`, and not to Horizons.
      expect(gameIds((await detail(creator, namingHorizonsId.id, 'the creator')).worksWith)).toEqual([
        sameIdAsHorizons.id,
      ]);
      expect(gameIds((await detail(creator, sameIdAsSpiritIsland.id, 'the creator')).worksWith)).toEqual([]);
      expect(gameIds((await detail(creator, spiritIsland.id, 'the creator')).worksWith)).toEqual([horizons.id]);
    });
  });

  describe('contents links and bundles', () => {
    // Its content type is Expansion, as a BoardGameGeek expansion that lists
    // contents keeps: no content type gates contents or bundles (#1394).
    it("lists Dominion among Dominion: Big Box's contents, and the Big Box among Dominion's bundles, when only the Big Box names it (#1394)", async () => {
      const creator = await actors.user();
      const t = token();
      const gateway = await arrangeGateway('Contents gateway');
      const bigBox = await arrangeGame(creator.user.id, Reach.Public, `Dominion: Big Box ${t}`, ContentType.Expansion);
      const dominion = await arrangeGame(creator.user.id, Reach.Public, `Dominion ${t}`);
      await arrangeDataGatewayLink(bigBox.id, gateway.id, '137166', { contentExternalIds: ['36218'] });
      await arrangeDataGatewayLink(dominion.id, gateway.id, '36218');

      expect(await detail(creator, bigBox.id, 'the creator')).toEqual({
        worksWith: [],
        contents: [linkTo(dominion)],
        bundles: [],
      });
      expect(await detail(creator, dominion.id, 'the creator')).toEqual({
        worksWith: [],
        contents: [],
        bundles: [linkTo(bigBox)],
      });
    });

    // IGDB sends a game's bundles on the contained game, and nothing on the
    // bundle, so the contained game's DataGateway link alone names it.
    it('lists the bundle when only the contained game names it, as IGDB sends it (#1394)', async () => {
      const creator = await actors.user();
      const t = token();
      const gateway = await arrangeGateway('Bundle gateway');
      const trilogy = await arrangeGame(creator.user.id, Reach.Public, `Mass Effect Trilogy ${t}`, ContentType.Bundle);
      const massEffect = await arrangeGame(creator.user.id, Reach.Public, `Mass Effect ${t}`);
      await arrangeDataGatewayLink(trilogy.id, gateway.id, '1985');
      await arrangeDataGatewayLink(massEffect.id, gateway.id, '73', { bundleExternalIds: ['1985'] });

      expect(await detail(creator, massEffect.id, 'the creator')).toEqual({
        worksWith: [],
        contents: [],
        bundles: [linkTo(trilogy)],
      });
      expect(await detail(creator, trilogy.id, 'the creator')).toEqual({
        worksWith: [],
        contents: [linkTo(massEffect)],
        bundles: [],
      });
    });
  });

  // The linked game is named only if the actor could open it by id, as an
  // add-on link's is (#1069). The Private and Public games are named in all
  // three lists, so each list's read is shown to keep the ceiling, and the
  // Public one is the control on the same response.
  it('names no linked game the actor may not open (#1392)', async () => {
    const creator = await actors.user();
    const stranger = await actors.user();
    const t = token();
    const gateway = await arrangeGateway('Ceiling gateway');
    const near = await arrangeGame(creator.user.id, Reach.Public, `Near ${t}`);
    const privateFar = await arrangeGame(creator.user.id, Reach.Private, `A private far ${t}`);
    const publicFar = await arrangeGame(creator.user.id, Reach.Public, `B public far ${t}`);
    const both = ['1', '2'];
    await arrangeDataGatewayLink(near.id, gateway.id, '0', {
      worksWithExternalIds: both,
      contentExternalIds: both,
      bundleExternalIds: both,
    });
    await arrangeDataGatewayLink(privateFar.id, gateway.id, '1');
    await arrangeDataGatewayLink(publicFar.id, gateway.id, '2');

    // The control: the creator, who can open both, is sent both in each list.
    const creators = await detail(creator, near.id, 'the creator');
    expect(gameIds(creators.worksWith)).toEqual([privateFar.id, publicFar.id]);
    expect(gameIds(creators.contents)).toEqual([privateFar.id, publicFar.id]);
    expect(gameIds(creators.bundles)).toEqual([privateFar.id, publicFar.id]);

    const strangerResponse = await readDetail(stranger, near.id);
    const strangers = gameLinks(strangerResponse, `GET ${GAMES_PATH}/:id as a stranger`);
    expect(gameIds(strangers.worksWith)).toEqual([publicFar.id]);
    expect(gameIds(strangers.contents)).toEqual([publicFar.id]);
    expect(gameIds(strangers.bundles)).toEqual([publicFar.id]);
    expect(JSON.stringify(strangerResponse.body)).not.toContain(privateFar.id);
  });

  // A link holds on the platforms both its games are on, as an add-on link
  // does (#1391). One that holds on none is still listed: the game on PC alone
  // is named beside the Tabletop one, with no platform to play it on.
  //
  // The Tabletop far game is a standalone expansion, and each entry's
  // `isStandalone` is the linked game's own (#1392): true where `near` lists
  // it, beside false for the PC game in the same list, and false where it
  // lists `near`, though the game viewed there is the standalone one.
  it('sends the platforms a link holds on, and lists one holding on none with empty platformIds (#1392)', async () => {
    const creator = await actors.user();
    const t = token();
    const tabletop = await tabletopPlatform(db.client);
    const pc = await arrangePlatform(`PC ${t}`, PlatformType.PC);
    const gateway = await arrangeGateway('Platform gateway');
    const near = await arrangeGame(creator.user.id, Reach.Public, `Near ${t}`);
    const onTabletop = await arrangeGame(
      creator.user.id,
      Reach.Public,
      `A tabletop far ${t}`,
      ContentType.StandaloneExpansion,
    );
    const onPc = await arrangeGame(creator.user.id, Reach.Public, `B PC far ${t}`);
    await arrangePlatformGame(near.id, tabletop.id);
    await arrangePlatformGame(onTabletop.id, tabletop.id);
    await arrangePlatformGame(onPc.id, pc.id);
    await arrangeDataGatewayLink(near.id, gateway.id, '1', { worksWithExternalIds: ['2', '3'] });
    await arrangeDataGatewayLink(onTabletop.id, gateway.id, '2');
    await arrangeDataGatewayLink(onPc.id, gateway.id, '3');

    const entriesOf = (links: GameLinksWire['worksWith']) =>
      links.map(({ gameId, isStandalone, platformIds }) => ({ gameId, isStandalone, platformIds }));

    expect(entriesOf((await detail(creator, near.id, 'the creator')).worksWith)).toEqual([
      { gameId: onTabletop.id, isStandalone: true, platformIds: [tabletop.id] },
      { gameId: onPc.id, isStandalone: false, platformIds: [] },
    ]);
    expect(entriesOf((await detail(creator, onTabletop.id, 'the creator')).worksWith)).toEqual([
      { gameId: near.id, isStandalone: false, platformIds: [tabletop.id] },
    ]);
    expect(entriesOf((await detail(creator, onPc.id, 'the creator')).worksWith)).toEqual([
      { gameId: near.id, isStandalone: false, platformIds: [] },
    ]);
  });
});
