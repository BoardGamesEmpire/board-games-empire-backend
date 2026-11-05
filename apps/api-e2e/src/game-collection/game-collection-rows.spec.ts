import { ContentType, GameMedium, Reach, type Prisma } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  collectionRowPlatformGame,
  listCollectionsEnvelope,
  readCollectionEnvelope,
  type CollectionRowPlatformGameWire,
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

  /**
   * One collection entry for `ownerId` on a game of its own, held on the
   * seeded `tabletop` platform, which survives the sweep. `reach` is the
   * entry's; the game's own values, its reach included, come in `game`.
   */
  const arrangeRow = async (
    ownerId: string,
    options: {
      readonly reach: Reach;
      readonly game?: Partial<Prisma.GameUncheckedCreateInput>;
      readonly platformGame?: Pick<
        Prisma.PlatformGameUncheckedCreateInput,
        'minPlayers' | 'maxPlayers' | 'minPlayTime' | 'maxPlayTime'
      >;
    },
  ) => {
    const tabletop = await db.client.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true } });
    const game = await db.client.game.create({
      data: { title: `e2e game ${token()}`, ...options.game },
      select: { id: true },
    });
    const platformGame = await db.client.platformGame.create({
      data: { gameId: game.id, platformId: tabletop.id, ...options.platformGame },
      select: { id: true },
    });
    const entry = await db.client.gameCollection.create({
      data: { userId: ownerId, platformGameId: platformGame.id, medium: GameMedium.Physical, reach: options.reach },
      select: { id: true },
    });

    return { entryId: entry.id, gameId: game.id };
  };

  const listOwn = (actor: AuthenticatedActor) => request(baseUrl).get(COLLECTIONS_PATH).set(actor.headers);

  const readEntry = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${id}`).set(actor.headers);

  /** The entry's embedded platform game, from the owner's list and from its own read, in that order. */
  const embeddedEverywhere = async (
    owner: AuthenticatedActor,
    entryId: string,
  ): Promise<readonly CollectionRowPlatformGameWire[]> => {
    const listRequest = `GET ${COLLECTIONS_PATH} as the owner`;
    const listed = listCollectionsEnvelope(await listOwn(owner).expect(200), listRequest).collections.find(
      (row) => row.id === entryId,
    );
    if (listed === undefined) {
      throw new Error(`${listRequest}: the page carried no row for entry ${entryId}`);
    }

    const readRequest = `GET ${COLLECTIONS_PATH}/:id as the owner`;
    const { collection } = readCollectionEnvelope(await readEntry(owner, entryId).expect(200), readRequest);

    return [collectionRowPlatformGame(listed, listRequest), collectionRowPlatformGame(collection, readRequest)];
  };

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
    const { platformType } = await db.client.platform.findUniqueOrThrow({
      where: { slug: 'tabletop' },
      select: { platformType: true },
    });

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
});
