import { ContentType, GameMedium, Reach, ResourceType, type Prisma } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { tabletopPlatform } from '../support/seeded-platforms';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import type { HttpResponseLike, RequestDescription } from '../support/wire';
import {
  collectionRowPlatformGame,
  listCollectionsEnvelope,
  readCollectionEnvelope,
  type CollectionRowPlatformGameWire,
  type PlayerAndPlayTimeField,
} from './game-collection-wire';

/**
 * What a collection row embeds of its game and platform game (#1070), against
 * real rows. A client filters, sorts and nests a collection on the device, so
 * each row carries the facts that takes: the game's content type, year,
 * players and play time, the platform game's overrides of those, and the
 * platform's type. Each fact is named in the include, so no column ships by
 * default (#460).
 */
describe('collection rows (#1070)', () => {
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

  const token = () => randomUUID().slice(0, 8);

  interface PlatformGameOptions {
    /** The game's own values, its reach included. */
    readonly game?: Partial<Prisma.GameUncheckedCreateInput>;
    /** The platform game's overrides of the game's players and play time. */
    readonly platformGame?: Pick<Prisma.PlatformGameUncheckedCreateInput, PlayerAndPlayTimeField>;
  }

  /** A game of its own and its platform game on the seeded Tabletop platform. */
  const arrangePlatformGame = async (options: PlatformGameOptions = {}) => {
    const tabletop = await tabletopPlatform(db.client);
    const game = await db.client.game.create({
      data: { title: `e2e game ${token()}`, ...options.game },
      select: { id: true },
    });
    const platformGame = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: tabletop.id, ...options.platformGame },
      select: { id: true },
    });

    return { gameId: game.id, platformGameId: platformGame.id };
  };

  /** One collection entry for `ownerId` on a platform game of its own. `reach` is the entry's. */
  const arrangeRow = async (
    ownerId: string,
    { reach, ...options }: PlatformGameOptions & { readonly reach: Reach },
  ) => {
    const { gameId, platformGameId } = await arrangePlatformGame(options);
    const entry = await db.client.gameCollection.create({
      data: { userId: ownerId, platformGameId, medium: GameMedium.Physical, reach },
      select: { id: true },
    });

    return { entryId: entry.id, gameId };
  };

  const listOwn = (caller: Caller) => request(baseUrl).get(COLLECTIONS_PATH).set(caller.headers);

  const readEntry = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${id}`).set(actor.headers);

  /** The platform game embedded in the row for `entryId` on a page of collection rows. */
  const embeddedOnPage = (
    response: HttpResponseLike,
    entryId: string,
    description: RequestDescription,
  ): CollectionRowPlatformGameWire => {
    const row = listCollectionsEnvelope(response, description).collections.find((listed) => listed.id === entryId);
    if (row === undefined) {
      throw new Error(`${description}: the page carried no row for entry ${entryId}`);
    }

    return collectionRowPlatformGame(row, description);
  };

  /** The platform game embedded in the one row a response carries. */
  const embeddedIn = (response: HttpResponseLike, description: RequestDescription): CollectionRowPlatformGameWire =>
    collectionRowPlatformGame(readCollectionEnvelope(response, description).collection, description);

  /** The entry's embedded platform game, from the owner's list and from its own read, in that order. */
  const embeddedEverywhere = async (
    owner: AuthenticatedActor,
    entryId: string,
  ): Promise<readonly CollectionRowPlatformGameWire[]> => [
    embeddedOnPage(await listOwn(owner).expect(200), entryId, `GET ${COLLECTIONS_PATH} as the owner`),
    embeddedIn(await readEntry(owner, entryId).expect(200), `GET ${COLLECTIONS_PATH}/:id as the owner`),
  ];

  const arrangeGame = (createdById: string, reach: Reach, title: string, deletedAt: Date | null = null) =>
    db.client.game.create({ data: { title, reach, createdById, deletedAt }, select: { id: true } });

  const arrangeLink = (baseGameId: string, expansionGameId: string, isStandalone: boolean) =>
    db.client.gameExpansion.create({ data: { baseGameId, expansionGameId, isStandalone }, select: { id: true } });

  it("sends the game's and platform game's list facts on every collection row (#1070)", async () => {
    // Actors first, rows before anyone's first authenticated request (#256
    // ordering rule): the ability cache fills lazily per user.
    const owner = await actors.user();
    const full = await arrangeRow(owner.user.id, {
      reach: Reach.Private,
      game: {
        contentType: ContentType.Expansion,
        publishYear: 2001,
        minPlayers: 2,
        maxPlayers: 4,
        minPlayTime: 30,
        maxPlayTime: 60,
      },
      platformGame: { minPlayers: 1, maxPlayers: 5, minPlayTime: 20, maxPlayTime: 90 },
    });
    const bare = await arrangeRow(owner.user.id, { reach: Reach.Private });
    const { platformType } = await tabletopPlatform(db.client);

    for (const platformGame of await embeddedEverywhere(owner, full.entryId)) {
      expect(platformGame.game).toMatchObject({
        id: full.gameId,
        contentType: ContentType.Expansion,
        publishYear: 2001,
        minPlayers: 2,
        maxPlayers: 4,
        minPlayTime: 30,
        maxPlayTime: 60,
      });
      expect(platformGame).toMatchObject({ minPlayers: 1, maxPlayers: 5, minPlayTime: 20, maxPlayTime: 90 });
      expect(platformGame.platform.platformType).toBe(platformType);
    }

    // A fact the game or platform game leaves unset is sent as null, never left
    // off: a client reading an absent key cannot tell "unknown" from "not sent".
    for (const platformGame of await embeddedEverywhere(owner, bare.entryId)) {
      expect(platformGame.game).toMatchObject({
        id: bare.gameId,
        contentType: ContentType.BaseGame,
        publishYear: null,
        minPlayers: null,
        maxPlayers: null,
        minPlayTime: null,
        maxPlayTime: null,
      });
      expect(platformGame).toMatchObject({ minPlayers: null, maxPlayers: null, minPlayTime: null, maxPlayTime: null });
    }
  });

  /**
   * An expansion's base games on a row (#1070): the ones that are live and that
   * the viewer could open by id, the rule `GET /games/:id` uses. Each denial is
   * paired with a control on the same row, so it cannot pass because the links
   * were never there or reached no one. No route writes a link yet, so links
   * are arranged directly.
   */
  describe("an expansion's base games", () => {
    it("names the owner's Private base game on the owner's row and on no one else's (#1070)", async () => {
      const owner = await actors.user();
      const stranger = await actors.user();
      const anonymousUser = await actors.anonymous();
      const privateBase = await arrangeGame(owner.user.id, Reach.Private, `A private base ${token()}`);
      const publicBase = await arrangeGame(owner.user.id, Reach.Public, `B public base ${token()}`);
      const expansion = await arrangeRow(owner.user.id, {
        reach: Reach.Public,
        game: { reach: Reach.Public, createdById: owner.user.id, contentType: ContentType.Expansion },
      });
      await arrangeLink(privateBase.id, expansion.gameId, false);
      await arrangeLink(publicBase.id, expansion.gameId, true);

      // The control: the owner's row names both, in base game title order.
      const owners = embeddedOnPage(
        await listOwn(owner).expect(200),
        expansion.entryId,
        `GET ${COLLECTIONS_PATH} as the owner`,
      );
      expect(owners.game.baseGames).toEqual([
        { gameId: privateBase.id, isStandalone: false },
        { gameId: publicBase.id, isStandalone: true },
      ]);

      // Anyone else reads the same row with the Private base game left out and
      // the Public one still named, so the links did reach them. An anonymous
      // user opens the Public one through `read:game:public` (#1076).
      const viewers = [
        ['a stranger', stranger],
        ['an anonymous user', anonymousUser],
      ] as const;
      for (const [who, viewer] of viewers) {
        const response = await request(baseUrl)
          .get(`/api/users/${owner.user.id}/game-collections`)
          .set(viewer.headers)
          .expect(200);
        const seen = embeddedOnPage(response, expansion.entryId, `GET /api/users/:userId/game-collections as ${who}`);

        expect(seen.game.baseGames).toEqual([{ gameId: publicBase.id, isStandalone: true }]);
        expect(JSON.stringify(response.body)).not.toContain(privateBase.id);
      }
    });

    // A key's Game ceiling is a deny-all when it holds no game read. That
    // deny-all sits in the link read's own `where`, so the read fails closed
    // to no base games rather than refusing the rows the key may list.
    it('lists a key holding only the collection read its rows with no base game named, rather than refusing them (#1070)', async () => {
      const owner = await actors.user();
      const base = await arrangeGame(owner.user.id, Reach.Public, `e2e base ${token()}`);
      const expansion = await arrangeRow(owner.user.id, {
        reach: Reach.Private,
        game: { contentType: ContentType.Expansion },
      });
      await arrangeLink(base.id, expansion.gameId, false);
      const collectionRead = { slugs: ['read:game_collection'], resourceType: ResourceType.GameCollection };
      const collectionOnly = await mintApiKey(baseUrl, db.client, owner, collectionRead);
      const withGameRead = await mintApiKey(baseUrl, db.client, owner, [
        collectionRead,
        { slugs: ['read:game'], resourceType: ResourceType.Game },
      ]);

      // The control: the same owner's key, with their own-games read beside
      // it, names the base game they created.
      const named = embeddedOnPage(
        await listOwn(withGameRead).expect(200),
        expansion.entryId,
        `GET ${COLLECTIONS_PATH} with a key holding read:game`,
      );
      expect(named.game.baseGames).toEqual([{ gameId: base.id, isStandalone: false }]);

      const unnamed = embeddedOnPage(
        await listOwn(collectionOnly).expect(200),
        expansion.entryId,
        `GET ${COLLECTIONS_PATH} with a key holding the collection read alone`,
      );
      expect(unnamed.game.baseGames).toEqual([]);
    });

    it('leaves a soft-deleted base game off a row even for staff, who can still open it by id (#1070)', async () => {
      const admin = await actors.admin();
      const liveBase = await arrangeGame(admin.user.id, Reach.Public, `e2e live base ${token()}`);
      const deletedBase = await arrangeGame(admin.user.id, Reach.Public, `e2e deleted base ${token()}`, new Date());
      const expansion = await arrangeRow(admin.user.id, {
        reach: Reach.Private,
        game: { contentType: ContentType.Expansion },
      });
      await arrangeLink(liveBase.id, expansion.gameId, false);
      await arrangeLink(deletedBase.id, expansion.gameId, false);

      const admins = embeddedOnPage(
        await listOwn(admin).expect(200),
        expansion.entryId,
        `GET ${COLLECTIONS_PATH} as an admin`,
      );
      expect(admins.game.baseGames).toEqual([{ gameId: liveBase.id, isStandalone: false }]);

      // The control: staff read every game unconditioned, and the admin opens
      // the deleted base game by id. So the read ceiling did not leave it off
      // the row; the liveness test did.
      await request(baseUrl).get(`/api/games/${deletedBase.id}`).set(admin.headers).expect(200);
    });

    it('names the base game on the rows POST, PATCH and DELETE return (#1070)', async () => {
      const owner = await actors.user();
      const base = await arrangeGame(owner.user.id, Reach.Public, `e2e base ${token()}`);
      // No entry yet: the POST makes it.
      const expansion = await arrangePlatformGame({ game: { contentType: ContentType.Expansion } });
      await arrangeLink(base.id, expansion.gameId, true);
      const expected = [{ gameId: base.id, isStandalone: true }];

      const created = await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({ platformGameId: expansion.platformGameId, medium: GameMedium.Physical })
        .expect(201);
      expect(embeddedIn(created, `POST ${COLLECTIONS_PATH}`).game.baseGames).toEqual(expected);
      const entryId = readCollectionEnvelope(created, `POST ${COLLECTIONS_PATH}`).collection.id;

      const patched = await request(baseUrl)
        .patch(`${COLLECTIONS_PATH}/${entryId}`)
        .set(owner.headers)
        .send({ quantity: 2 })
        .expect(200);
      expect(embeddedIn(patched, `PATCH ${COLLECTIONS_PATH}/:id`).game.baseGames).toEqual(expected);

      const removed = await request(baseUrl).delete(`${COLLECTIONS_PATH}/${entryId}`).set(owner.headers).expect(200);
      expect(embeddedIn(removed, `DELETE ${COLLECTIONS_PATH}/:id`).game.baseGames).toEqual(expected);
    });
  });

  /**
   * The catch-up drain (#1070): `updatedSince` resends a row when the entry
   * changed or a value it embeds did, so a client that pulls only changes
   * still sees a new link or an edited base game.
   *
   * `since` is taken after every row is arranged, and the changes are made
   * after a pause, so each arranged `updatedAt` is strictly before it and each
   * change at or after it. Prisma stamps `updatedAt` with this machine's clock,
   * the one `since` is read from.
   */
  describe('the catch-up drain', () => {
    const drainedRows = async (owner: AuthenticatedActor, since: Date) => {
      const description = `GET ${COLLECTIONS_PATH}?updatedSince as the owner`;
      const response = await request(baseUrl)
        .get(COLLECTIONS_PATH)
        .query({ updatedSince: since.toISOString() })
        .set(owner.headers)
        .expect(200);

      return listCollectionsEnvelope(response, description).collections.map((row) => ({
        id: row.id,
        baseGames: collectionRowPlatformGame(row, description).game.baseGames,
      }));
    };

    const startOfChanges = async () => {
      const since = new Date(Date.now() + 1);
      await setTimeout(10);

      return since;
    };

    it('resends a row when its game gains a link or its base game changes, and not an untouched neighbor (#1070)', async () => {
      const owner = await actors.user();
      const linked = await arrangeRow(owner.user.id, { reach: Reach.Private });
      const linkedBase = await arrangeGame(owner.user.id, Reach.Public, `e2e base ${token()}`);
      await arrangeLink(linkedBase.id, linked.gameId, false);
      const unlinked = await arrangeRow(owner.user.id, { reach: Reach.Private });
      const untouched = await arrangeRow(owner.user.id, { reach: Reach.Private });

      const since = await startOfChanges();
      await db.client.game.update({ where: { id: linkedBase.id }, data: { title: `e2e renamed base ${token()}` } });
      const newBase = await arrangeGame(owner.user.id, Reach.Public, `e2e new base ${token()}`);
      await arrangeLink(newBase.id, unlinked.gameId, true);

      const drained = await drainedRows(owner, since);

      // The untouched row is the control: the drain is not every row.
      expect(drained.map((row) => row.id).sort()).toEqual([linked.entryId, unlinked.entryId].sort());
      expect(drained.find((row) => row.id === unlinked.entryId)?.baseGames).toEqual([
        { gameId: newBase.id, isStandalone: true },
      ]);
      expect(drained.map((row) => row.id)).not.toContain(untouched.entryId);
    });

    // The release is embedded too, and a re-import rewrites it in place.
    it('resends a row when its release changes, and not an untouched neighbor (#1070)', async () => {
      const owner = await actors.user();
      const released = await arrangeRow(owner.user.id, { reach: Reach.Private });
      const untouched = await arrangeRow(owner.user.id, { reach: Reach.Private });
      const { platformGameId } = await db.client.gameCollection.findUniqueOrThrow({
        where: { id: released.entryId },
        select: { platformGameId: true },
      });
      const release = await db.client.gameRelease.create({
        data: { platformGameId, editionKey: `e2e edition ${token()}`, editionName: 'First edition' },
        select: { id: true },
      });
      await db.client.gameCollection.update({ where: { id: released.entryId }, data: { releaseId: release.id } });

      const since = await startOfChanges();
      await db.client.gameRelease.update({ where: { id: release.id }, data: { editionName: 'Second edition' } });

      // The untouched row is the control: the drain is not every row.
      const drained = (await drainedRows(owner, since)).map((row) => row.id);
      expect(drained).toEqual([released.entryId]);
      expect(drained).not.toContain(untouched.entryId);
    });

    // A base game deleted outright takes its link with it (cascade), so no
    // embedded row is left whose `updatedAt` could be tested, and the client
    // keeps the stale id until it reloads in full. Games are hard-deleted
    // (#476); this test pins the gap as recorded on #1070, and a fix there
    // flips it on purpose.
    it('resends nothing when a base game is hard-deleted, the gap #476 records (#1070)', async () => {
      const owner = await actors.user();
      const row = await arrangeRow(owner.user.id, { reach: Reach.Private });
      const base = await arrangeGame(owner.user.id, Reach.Public, `e2e base ${token()}`);
      await arrangeLink(base.id, row.gameId, false);

      const since = await startOfChanges();
      await db.client.game.delete({ where: { id: base.id } });

      expect(await drainedRows(owner, since)).toEqual([]);
      // The full read is how a client learns the base game is gone.
      expect(
        embeddedIn(await readEntry(owner, row.entryId).expect(200), `GET ${COLLECTIONS_PATH}/:id`).game.baseGames,
      ).toEqual([]);
    });
  });
});
