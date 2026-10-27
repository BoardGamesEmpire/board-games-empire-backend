import { ContentType, PlatformType, Reach } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { localSearchGameIds } from './game-wire';

/**
 * A search in the game catalog narrowed by each of its five filters, against
 * real rows: platform type and content type (#713), publish year (#719),
 * player count and play time (#869). A game matches content types by its
 * own, and platform types by the platforms it's on, so a game on none matches
 * no platform type. Portable is stored as itself, so a filter on it finds a
 * game on a portable platform. Each of the three ranges keeps a game with no
 * known value only when asked, and a blank bound narrows nothing. A bound
 * below its floor or past a 32-bit integer, or a maximum below its minimum,
 * answers 400.
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

  /** A public base game in the game catalog, with the player counts and play times it's given (#869). */
  const arrangeRanged = async (
    title: string,
    values: { minPlayers?: number; maxPlayers?: number; minPlayTime?: number; maxPlayTime?: number },
    createdById: string,
  ) =>
    (
      await db.client.game.create({
        data: { title, ...values, contentType: ContentType.BaseGame, reach: Reach.Public, createdById },
        select: { id: true },
      })
    ).id;

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

  // A game night's player count is everyone who might come, so a bound alone
  // is one count: a minimum of 5 finds games for 5, not for 5 or more. A game
  // missing either count is unknown, and kept only when asked (#869).
  it('narrows the search in the game catalog by player count, keeping a game missing a count only when asked', async () => {
    const user = await actors.user();
    const token = randomUUID().slice(0, 8);

    const upToFour = await arrangeRanged(`Players ${token} 2-4`, { minPlayers: 2, maxPlayers: 4 }, user.user.id);
    const upToSix = await arrangeRanged(`Players ${token} 2-6`, { minPlayers: 2, maxPlayers: 6 }, user.user.id);
    const noMaximum = await arrangeRanged(`Players ${token} 2-unknown`, { minPlayers: 2 }, user.user.id);

    expect(await searchedIds(user, { query: token })).toEqual([upToFour, upToSix, noMaximum].sort());
    expect(await searchedIds(user, { query: token, playerCountMin: '5' })).toEqual([upToSix]);
    expect(await searchedIds(user, { query: token, playerCountMin: '3', playerCountMax: '4' })).toEqual(
      [upToFour, upToSix].sort(),
    );
    expect(
      await searchedIds(user, {
        query: token,
        playerCountMin: '3',
        playerCountMax: '4',
        playerCountIncludeUnknown: 'true',
      }),
    ).toEqual([upToFour, upToSix, noMaximum].sort());
  });

  // A game's whole play time, in minutes, must fit the range, and a game with
  // one play time takes that long. A bound left out doesn't narrow that side,
  // and only a game with neither time is unknown (#869).
  it('narrows it by play time in minutes, reading a game with one time as that time', async () => {
    const user = await actors.user();
    const token = randomUUID().slice(0, 8);

    const upToAnHour = await arrangeRanged(`Time ${token} 30-60`, { minPlayTime: 30, maxPlayTime: 60 }, user.user.id);
    const upToTwoHours = await arrangeRanged(
      `Time ${token} 30-120`,
      { minPlayTime: 30, maxPlayTime: 120 },
      user.user.id,
    );
    const anHour = await arrangeRanged(`Time ${token} 60`, { minPlayTime: 60 }, user.user.id);
    const untimed = await arrangeRanged(`Time ${token} untimed`, {}, user.user.id);

    expect(await searchedIds(user, { query: token })).toEqual([upToAnHour, upToTwoHours, anHour, untimed].sort());
    expect(await searchedIds(user, { query: token, playTimeMax: '90' })).toEqual([upToAnHour, anHour].sort());
    // Both 30-minute games can end too soon, whatever their longest time.
    expect(await searchedIds(user, { query: token, playTimeMin: '45' })).toEqual([anHour]);
    expect(await searchedIds(user, { query: token, playTimeMax: '90', playTimeIncludeUnknown: 'true' })).toEqual(
      [upToAnHour, anHour, untimed].sort(),
    );
    // A blank bound is absent, not 0, so it narrows nothing.
    expect(await searchedIds(user, { query: token, playTimeMax: '', playTimeIncludeUnknown: 'true' })).toEqual(
      [upToAnHour, upToTwoHours, anHour, untimed].sort(),
    );
  });

  // A game takes at least one player, and no game plays in negative time (#869).
  it('refuses a player count below 1, a negative play time, or a maximum below its minimum, with 400', async () => {
    const user = await actors.user();

    await search(user, { query: 'anything', playerCountMin: '0' }).expect(400);
    await search(user, { query: 'anything', playerCountMax: '0' }).expect(400);
    await search(user, { query: 'anything', playTimeMin: '-1' }).expect(400);
    await search(user, { query: 'anything', playerCountMin: '4', playerCountMax: '3' }).expect(400);
    await search(user, { query: 'anything', playTimeMin: '90', playTimeMax: '60' }).expect(400);

    await search(user, { query: 'anything', playerCountMin: '1', playerCountMax: '1' }).expect(200);
    await search(user, { query: 'anything', playTimeMin: '0', playTimeMax: '0' }).expect(200);
  });
});
