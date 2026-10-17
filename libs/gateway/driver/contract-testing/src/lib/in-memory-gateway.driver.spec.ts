import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { InMemoryGatewayDriver } from './in-memory-gateway.driver.js';
import { runDataGatewayDriverContract } from './run-data-gateway-driver-contract.js';

const { COVERAGE_AXIS_PLATFORM_TYPE: PLATFORM_TYPE_AXIS, COVERAGE_AXIS_CONTENT_TYPE: CONTENT_TYPE_AXIS } =
  proto.CoverageAxis;
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
    coverage: { platformTypes: [TABLETOP], contentTypes: [BASE_GAME, EXPANSION] },
    filterableAxes: [PLATFORM_TYPE_AXIS, CONTENT_TYPE_AXIS],
  }),
  capabilities: [
    proto.Capability.CAPABILITY_SEARCH,
    proto.Capability.CAPABILITY_FETCH,
    proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
    proto.Capability.CAPABILITY_LIST_LANGUAGES,
  ],
  filterableAxes: [PLATFORM_TYPE_AXIS, CONTENT_TYPE_AXIS],
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
