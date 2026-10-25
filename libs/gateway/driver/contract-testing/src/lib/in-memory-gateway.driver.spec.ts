import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { InMemoryGatewayDriver } from './in-memory-gateway.driver.js';
import { runDataGatewayDriverContract } from './run-data-gateway-driver-contract.js';

const {
  SEARCH_FILTER_AXIS_PLATFORM_TYPE: PLATFORM_TYPE_AXIS,
  SEARCH_FILTER_AXIS_CONTENT_TYPE: CONTENT_TYPE_AXIS,
  SEARCH_FILTER_AXIS_PUBLISH_YEAR: PUBLISH_YEAR_AXIS,
  SEARCH_FILTER_AXIS_PLAYER_COUNT: PLAYER_COUNT_AXIS,
  SEARCH_FILTER_AXIS_PLAY_TIME: PLAY_TIME_AXIS,
} = proto.SearchFilterAxis;
const { PLATFORM_TYPE_TABLETOP: TABLETOP, PLATFORM_TYPE_PC: PC } = proto.PlatformType;
const {
  CONTENT_TYPE_BASE_GAME: BASE_GAME,
  CONTENT_TYPE_EXPANSION: EXPANSION,
  CONTENT_TYPE_UNSPECIFIED: UNSPECIFIED,
} = proto.ContentType;

const knownGame = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameData;
const searchHit = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameSearchData;

/** A search result of `contentType`, on platforms of `platformTypes`. */
const hit = (
  externalId: string,
  contentType: proto.ContentType,
  platformTypes: proto.PlatformType[],
): proto.GameSearchData => ({
  externalId,
  title: externalId,
  contentType,
  availablePlatforms: platformTypes.map((platformType) => ({
    externalId: platformType,
    name: platformType,
    platformType,
  })),
  availableReleases: [],
});

const catan = hit('catan', BASE_GAME, [TABLETOP]);
const seafarers = hit('seafarers', EXPANSION, [TABLETOP]);
const catanUniverse = hit('catan-universe', BASE_GAME, [PC]);
const unclassified = hit('unclassified', UNSPECIFIED, []);

runDataGatewayDriverContract('InMemoryGatewayDriver', () => ({
  driver: new InMemoryGatewayDriver({
    games: [knownGame],
    searchResults: [searchHit],
    expansionsByBaseExternalId: { 'bgg-13': [searchHit] },
    languages: [{ value: 'en-US', format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47 }],
    platforms: [{ externalId: 'tabletop', name: 'Tabletop', platformType: TABLETOP }],
    categories: [{ externalId: '1009', name: 'Abstract Strategy' }],
    mechanics: [{ externalId: '2082', name: 'Worker Placement' }],
    coverage: { platformTypes: [TABLETOP], contentTypes: [BASE_GAME, EXPANSION] },
    filterableAxes: [PLATFORM_TYPE_AXIS, CONTENT_TYPE_AXIS, PUBLISH_YEAR_AXIS, PLAYER_COUNT_AXIS, PLAY_TIME_AXIS],
  }),
  capabilities: [
    proto.Capability.CAPABILITY_SEARCH,
    proto.Capability.CAPABILITY_FETCH,
    proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
    proto.Capability.CAPABILITY_LIST_LANGUAGES,
    proto.Capability.CAPABILITY_LIST_PLATFORMS,
    proto.Capability.CAPABILITY_LIST_CATEGORIES,
    proto.Capability.CAPABILITY_LIST_MECHANICS,
  ],
  filterableAxes: [PLATFORM_TYPE_AXIS, CONTENT_TYPE_AXIS, PUBLISH_YEAR_AXIS, PLAYER_COUNT_AXIS, PLAY_TIME_AXIS],
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

// It narrows by an axis its coverage lists nothing on, so the filtered search
// still runs, on a value of the contract's own.
runDataGatewayDriverContract('InMemoryGatewayDriver narrowing by an axis it covers nothing on', () => ({
  driver: new InMemoryGatewayDriver({
    searchResults: [searchHit],
    capabilities: [proto.Capability.CAPABILITY_SEARCH],
    filterableAxes: [CONTENT_TYPE_AXIS],
  }),
  capabilities: [proto.Capability.CAPABILITY_SEARCH],
  filterableAxes: [CONTENT_TYPE_AXIS],
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

// Every operation but fetch answers UNIMPLEMENTED here, so this passes only
// if the suite leaves out the operations a driver doesn't declare.
runDataGatewayDriverContract('InMemoryGatewayDriver declaring only fetch', () => ({
  driver: new InMemoryGatewayDriver({ games: [knownGame], capabilities: [proto.Capability.CAPABILITY_FETCH] }),
  capabilities: [proto.Capability.CAPABILITY_FETCH],
  filterableAxes: [],
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

describe('InMemoryGatewayDriver search filter', () => {
  const searchResults = [catan, seafarers, catanUniverse, unclassified];

  const search = (driver: InMemoryGatewayDriver, filter: proto.SearchFilter) =>
    lastValueFrom(driver.searchGames({ correlationId: 'x', query: 'catan', filter }).pipe(toArray()));

  const externalIds = (frames: proto.GatewaySearchResult[]) =>
    frames.flatMap((frame) => (frame.game ? [frame.game.externalId] : []));

  it('narrows by each axis it declares, and never matches an unknown value', async () => {
    const driver = new InMemoryGatewayDriver({
      searchResults,
      filterableAxes: [PLATFORM_TYPE_AXIS, CONTENT_TYPE_AXIS],
    });

    await expect(search(driver, { platformTypes: [TABLETOP], contentTypes: [] }).then(externalIds)).resolves.toEqual([
      'catan',
      'seafarers',
    ]);
    await expect(
      search(driver, { platformTypes: [TABLETOP, PC], contentTypes: [BASE_GAME] }).then(externalIds),
    ).resolves.toEqual(['catan', 'catan-universe']);
    await expect(search(driver, { platformTypes: [], contentTypes: [UNSPECIFIED] }).then(externalIds)).resolves.toEqual(
      [],
    );
  });

  it('ignores an axis it doesn’t declare', async () => {
    const driver = new InMemoryGatewayDriver({ searchResults, filterableAxes: [CONTENT_TYPE_AXIS] });

    await expect(search(driver, { platformTypes: [PC], contentTypes: [EXPANSION] }).then(externalIds)).resolves.toEqual(
      ['seafarers'],
    );
  });

  it('applies a publish-year range on the axis it declares (#719)', async () => {
    const dated = (externalId: string, yearPublished?: number) => ({ ...catan, externalId, yearPublished });
    const searchResults = [dated('old', 1995), dated('new', 2010), dated('undated')];
    const declaring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [PUBLISH_YEAR_AXIS] });
    const ignoring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [CONTENT_TYPE_AXIS] });
    const byYear = (publishYear: proto.IntRange) => ({ platformTypes: [], contentTypes: [], publishYear });

    await expect(search(declaring, byYear({ min: 2000 })).then(externalIds)).resolves.toEqual(['new']);
    await expect(search(declaring, byYear({ max: 1995, includeUnknown: true })).then(externalIds)).resolves.toEqual([
      'old',
      'undated',
    ]);
    await expect(search(declaring, byYear({ includeUnknown: false })).then(externalIds)).resolves.toEqual([
      'old',
      'new',
      'undated',
    ]);
    await expect(search(ignoring, byYear({ min: 2000 })).then(externalIds)).resolves.toEqual(['old', 'new', 'undated']);
  });

  // A bound alone is one count, and a game missing either count is unknown (#869).
  it('applies a player-count range on the axis it declares (#869)', async () => {
    const counted = (externalId: string, minPlayers?: number | null, maxPlayers?: number | null) =>
      ({ ...catan, externalId, minPlayers, maxPlayers }) as proto.GameSearchData;
    const searchResults = [counted('two-four', 2, 4), counted('two-six', 2, 6), counted('two-unknown', 2, null)];
    const declaring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [PLAYER_COUNT_AXIS] });
    const ignoring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [PLAY_TIME_AXIS] });
    const byCount = (playerCount: proto.IntRange) => ({ platformTypes: [], contentTypes: [], playerCount });

    await expect(search(declaring, byCount({ min: 5 })).then(externalIds)).resolves.toEqual(['two-six']);
    await expect(search(declaring, byCount({ min: 3, max: 4 })).then(externalIds)).resolves.toEqual([
      'two-four',
      'two-six',
    ]);
    await expect(search(declaring, byCount({ max: 6, includeUnknown: true })).then(externalIds)).resolves.toEqual([
      'two-six',
      'two-unknown',
    ]);
    await expect(search(declaring, byCount({ includeUnknown: false })).then(externalIds)).resolves.toEqual([
      'two-four',
      'two-six',
      'two-unknown',
    ]);
    await expect(search(ignoring, byCount({ min: 5 })).then(externalIds)).resolves.toEqual([
      'two-four',
      'two-six',
      'two-unknown',
    ]);
  });

  // A game with one play time plays that long, and a bound left out doesn't narrow that side (#869).
  it('applies a play-time range on the axis it declares (#869)', async () => {
    const timed = (externalId: string, minPlaytime?: number | null, maxPlaytime?: number | null) =>
      ({ ...catan, externalId, minPlaytime, maxPlaytime }) as proto.GameSearchData;
    const searchResults = [
      timed('short', 30, 60),
      timed('long', 30, 120),
      timed('one-time', 60),
      timed('untimed', null),
    ];
    const declaring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [PLAY_TIME_AXIS] });
    const ignoring = new InMemoryGatewayDriver({ searchResults, filterableAxes: [PLAYER_COUNT_AXIS] });
    const byTime = (playTime: proto.IntRange) => ({ platformTypes: [], contentTypes: [], playTime });

    await expect(search(declaring, byTime({ max: 90 })).then(externalIds)).resolves.toEqual(['short', 'one-time']);
    await expect(search(declaring, byTime({ min: 45 })).then(externalIds)).resolves.toEqual(['one-time']);
    await expect(search(declaring, byTime({ min: 45, includeUnknown: true })).then(externalIds)).resolves.toEqual([
      'one-time',
      'untimed',
    ]);
    await expect(search(declaring, byTime({ includeUnknown: false })).then(externalIds)).resolves.toEqual([
      'short',
      'long',
      'one-time',
      'untimed',
    ]);
    await expect(search(ignoring, byTime({ max: 90 })).then(externalIds)).resolves.toEqual([
      'short',
      'long',
      'one-time',
      'untimed',
    ]);

    // A game with only a maximum plays that long too: it stands for the missing minimum.
    const maxOnly = new InMemoryGatewayDriver({
      searchResults: [timed('max-only', undefined, 60)],
      filterableAxes: [PLAY_TIME_AXIS],
    });

    await expect(search(maxOnly, byTime({ min: 45 })).then(externalIds)).resolves.toEqual(['max-only']);
    await expect(search(maxOnly, byTime({ min: 75 })).then(externalIds)).resolves.toEqual([]);
  });

  it('declares the coverage and filterable axes it is given', async () => {
    const coverage = { platformTypes: [TABLETOP], contentTypes: [BASE_GAME] };
    const driver = new InMemoryGatewayDriver({ coverage, filterableAxes: [CONTENT_TYPE_AXIS] });

    await expect(firstValueFrom(driver.describe({}))).resolves.toMatchObject({
      coverage,
      filterableAxes: [CONTENT_TYPE_AXIS],
    });
  });
});

describe('InMemoryGatewayDriver capabilities', () => {
  it('declares the operations it is given', async () => {
    const driver = new InMemoryGatewayDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

    await expect(firstValueFrom(driver.describe({}))).resolves.toMatchObject({
      capabilities: [proto.Capability.CAPABILITY_FETCH],
    });
  });

  it('answers an operation it does not declare with UNIMPLEMENTED, and serves the ones it does', async () => {
    const driver = new InMemoryGatewayDriver({
      games: [knownGame],
      searchResults: [searchHit],
      capabilities: [proto.Capability.CAPABILITY_FETCH],
    });

    await expect(firstValueFrom(driver.searchGames({ correlationId: 'x', query: 'catan' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(
      firstValueFrom(driver.fetchExpansions({ correlationId: 'x', baseExternalId: 'bgg-13' })),
    ).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
    await expect(firstValueFrom(driver.listLanguages({ correlationId: 'x' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }))).resolves.toMatchObject(
      { game: knownGame },
    );
  });
  it('answers UNIMPLEMENTED for a list it does not declare', async () => {
    const driver = new InMemoryGatewayDriver({
      platforms: [{ externalId: 'tabletop', name: 'Tabletop', platformType: TABLETOP }],
      capabilities: [proto.Capability.CAPABILITY_FETCH],
    });

    await expect(firstValueFrom(driver.listPlatforms({ correlationId: 'x' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(firstValueFrom(driver.listCategories({ correlationId: 'x' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(firstValueFrom(driver.listMechanics({ correlationId: 'x' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
  });
});

describe('InMemoryGatewayDriver failure injection', () => {
  it('errors every RPC after failWith and recovers after restore', async () => {
    const driver = new InMemoryGatewayDriver({ games: [knownGame] });

    driver.failWith(new Error('boom'));
    await expect(firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }))).rejects.toThrow(
      'boom',
    );

    driver.restore();
    const response = await firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }));
    expect(response.game?.externalId).toBe('bgg-13');
  });

  it('errors describe after failWith too', async () => {
    const driver = new InMemoryGatewayDriver();

    driver.failWith(new Error('boom'));

    await expect(firstValueFrom(driver.describe({}))).rejects.toThrow('boom');
  });

  it('answers an operation it does not declare with the injected failure, not UNIMPLEMENTED', async () => {
    // A DataGateway that can't be reached can't say what it doesn't implement.
    const driver = new InMemoryGatewayDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

    driver.failWith(new Error('boom'));

    await expect(firstValueFrom(driver.searchGames({ correlationId: 'x', query: 'catan' }))).rejects.toThrow('boom');
  });

  it('tracks disposal', () => {
    const driver = new InMemoryGatewayDriver();

    expect(driver.disposed).toBe(false);
    driver.dispose();
    driver.dispose();
    expect(driver.disposed).toBe(true);
  });
});
