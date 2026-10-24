import { ContentType, PlatformType, Reach } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { localSearchGameIds } from './game-wire';

/**
 * A search narrowed by platform type and content type, on its local half,
 * against real rows (#713). A game matches content types by its own, and
 * platform types by the platforms it's on, so a game on none matches no
 * platform type. Portable is stored as itself, so a filter on it finds a
 * game on a portable platform.
 *
 * Every narrowed search is paired with the unfiltered one as its control, so
 * a filter can't pass by the search finding nothing at all.
 */
describe('game search filter', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PORTABLE_SLUG = 'e2e-portable';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  // Platforms survive the sweep as reference data, so the one this suite
  // adds goes once it's done, with the platform games the sweep left.
  afterAll(async () => {
    const portable = await db.client.platform.findUnique({ where: { slug: PORTABLE_SLUG }, select: { id: true } });
    if (portable) {
      await db.client.platformGame.deleteMany({ where: { platformId: portable.id } });
      await db.client.platform.delete({ where: { id: portable.id } });
    }

    await db.close();
  });

  // DataGateways are left out: this suite runs no coordinator, and the
  // local half is the one that reads the Game table.
  const search = (actor: AuthenticatedActor, query: Record<string, string>) =>
    request(baseUrl)
      .get('/api/games/search')
      .query({ includeExternal: false, ...query })
      .set(actor.headers);

  const searchedIds = async (actor: AuthenticatedActor, query: Record<string, string>) =>
    localSearchGameIds(await search(actor, query).expect(200), `GET /api/games/search ${JSON.stringify(query)}`)
      .slice()
      .sort();

  const platformId = async (slug: string, platformType: PlatformType) =>
    (
      await db.client.platform.upsert({
        where: { slug },
        create: { name: slug, slug, platformType },
        update: {},
        select: { id: true },
      })
    ).id;

  const arrangeGame = async (title: string, contentType: ContentType, platformIds: string[], createdById: string) => {
    const game = await db.client.game.create({
      data: { title, contentType, reach: Reach.Public, createdById },
      select: { id: true },
    });

    for (const id of platformIds) {
      await db.client.platformGame.create({ data: { gameId: game.id, platformId: id } });
    }

    return game.id;
  };

  it('narrows the local half by platform type and content type, and leaves out a game on no platform', async () => {
    const user = await actors.user();
    const tabletop = (await db.client.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true } }))
      .id;
    const portable = await platformId(PORTABLE_SLUG, PlatformType.Portable);

    const token = randomUUID().slice(0, 8);
    const tabletopBase = await arrangeGame(`Filter ${token} base`, ContentType.BaseGame, [tabletop], user.user.id);
    const tabletopExpansion = await arrangeGame(
      `Filter ${token} expansion`,
      ContentType.Expansion,
      [tabletop],
      user.user.id,
    );
    const portableBase = await arrangeGame(`Filter ${token} portable`, ContentType.BaseGame, [portable], user.user.id);
    const unplaced = await arrangeGame(`Filter ${token} unplaced`, ContentType.Unknown, [], user.user.id);

    expect(await searchedIds(user, { query: token })).toEqual(
      [tabletopBase, tabletopExpansion, portableBase, unplaced].sort(),
    );
    expect(await searchedIds(user, { query: token, platformTypes: 'Tabletop' })).toEqual(
      [tabletopBase, tabletopExpansion].sort(),
    );
    expect(await searchedIds(user, { query: token, platformTypes: 'Portable' })).toEqual([portableBase]);
    expect(await searchedIds(user, { query: token, contentTypes: 'BaseGame' })).toEqual(
      [tabletopBase, portableBase].sort(),
    );
    expect(await searchedIds(user, { query: token, platformTypes: 'Tabletop,PC', contentTypes: 'BaseGame' })).toEqual([
      tabletopBase,
    ]);
  });

  it('refuses a filter on unknown content, which names no kind of game, with 400', async () => {
    const user = await actors.user();

    await search(user, { query: 'anything', contentTypes: 'Unknown' }).expect(400);
    await search(user, { query: 'anything', contentTypes: 'BaseGame' }).expect(200);
  });

  // A publish-year range narrows the search in the game catalog too, and
  // leaves out a game with no known year unless asked to keep it (#719).
  it('narrows the search in the game catalog by publish year, keeping undated games only when asked', async () => {
    const user = await actors.user();
    const token = randomUUID().slice(0, 8);
    const arrangeDated = async (title: string, publishYear: number | null) =>
      (
        await db.client.game.create({
          data: {
            title,
            publishYear,
            contentType: ContentType.BaseGame,
            reach: Reach.Public,
            createdById: user.user.id,
          },
          select: { id: true },
        })
      ).id;

    const nineties = await arrangeDated(`Year ${token} 1995`, 1995);
    const recent = await arrangeDated(`Year ${token} 2010`, 2010);
    const undated = await arrangeDated(`Year ${token} undated`, null);

    expect(await searchedIds(user, { query: token })).toEqual([nineties, recent, undated].sort());
    expect(await searchedIds(user, { query: token, publishYearMin: '2000' })).toEqual([recent]);
    expect(await searchedIds(user, { query: token, publishYearMax: '1995' })).toEqual([nineties]);
    expect(
      await searchedIds(user, { query: token, publishYearMin: '2000', publishYearIncludeUnknown: 'true' }),
    ).toEqual([recent, undated].sort());
    expect(await searchedIds(user, { query: token, publishYearMin: '', publishYearIncludeUnknown: 'true' })).toEqual(
      [nineties, recent, undated].sort(),
    );
  });

  // Each bound travels as an int32, which would wrap a larger one into some other year.
  it('refuses a publish-year maximum below its minimum, or a bound past a 32-bit integer, with 400', async () => {
    const user = await actors.user();

    await search(user, { query: 'anything', publishYearMin: '2000', publishYearMax: '1990' }).expect(400);
    await search(user, { query: 'anything', publishYearMin: '3000000000' }).expect(400);
    await search(user, { query: 'anything', publishYearMin: '1990', publishYearMax: '1990' }).expect(200);
  });
});
