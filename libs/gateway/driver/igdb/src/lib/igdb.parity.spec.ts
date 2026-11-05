import type { DriverLogger, UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import {
  createRecordingFetch,
  expectGolden,
  isRecordingUpstream,
  writeFixture,
} from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { join } from 'node:path';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { IGDB_BASE_URL } from './client/igdb-query';
import { IgdbDriver } from './igdb.driver';
import { igdbFixtureFetch } from './testing/igdb-fixture-fetch';
import { igdbFixtureKey } from './testing/igdb-fixture-key';

/**
 * The driver sends what the IGDB remote DataGateway sent before its code
 * moved here: the goldens were recorded from its app, over the same upstream
 * fixtures, with the same requests (#1082).
 *
 * To record the goldens again from this driver, run this spec with
 * `BGE_RECORD_GOLDEN=true`, then review the diff. To record IGDB's answers
 * again too, add `BGE_RECORD_UPSTREAM=true`, `IGDB_CLIENT_ID` and
 * `IGDB_CLIENT_SECRET`: the driver then asks IGDB itself, through a
 * recording fetch. Record the goldens in the same run: IGDB answers a query
 * with no sort, such as fetchExpansions', in no fixed order.
 */
const TESTING = join(__dirname, '..', 'testing');
const FIXTURES = join(TESTING, 'fixtures');
const golden = (name: string) => join(TESTING, 'golden', name);

/** IGDB allows four requests a second; recording stays well under it (#1082). */
const RECORDING_PAUSE_MS = 500;

const paced: UpstreamFetch = async (url, request) => {
  await new Promise((resolve) => setTimeout(resolve, RECORDING_PAUSE_MS));
  return fetch(url, request);
};

/**
 * IGDB's answers to a query, kept as its fixture with the query beside it.
 * Nothing else is kept: the token endpoint's answer holds a credential (#1082).
 */
const recordQuery = ({ url, body }: { url: URL; body?: string }, answer: string): void => {
  if (!url.href.startsWith(`${IGDB_BASE_URL}/`)) {
    return;
  }

  const key = igdbFixtureKey(url.href.slice(IGDB_BASE_URL.length), body ?? '');
  writeFixture(FIXTURES, `${key}.json`, answer);
  writeFixture(FIXTURES, `${key}.apicalypse`, `${body ?? ''}\n`);
};

/** IGDB's recorded answers, or IGDB itself while recording. */
const upstream = (): UpstreamFetch =>
  isRecordingUpstream() ? createRecordingFetch(recordQuery, paced) : igdbFixtureFetch(FIXTURES);

const silent: DriverLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("IgdbDriver matches the IGDB remote DataGateway's recorded output", () => {
  const correlationId = 'golden';
  const driver = new IgdbDriver({
    fetch: upstream(),
    clientId: isRecordingUpstream() ? (process.env.IGDB_CLIENT_ID ?? '') : 'golden-client',
    clientSecret: isRecordingUpstream() ? (process.env.IGDB_CLIENT_SECRET ?? '') : 'golden-secret',
    version: '0.0.0-golden',
    logger: silent,
  });

  beforeAll(() => driver.start());

  const searched = (request: Omit<proto.GatewaySearchRequest, 'correlationId'>) =>
    lastValueFrom(driver.searchGames({ correlationId, ...request }).pipe(toArray()));

  jest.setTimeout(isRecordingUpstream() ? 120_000 : 5_000);

  // Ping's timestamp changes on every call, so ping has no golden (#1082).

  it('describe', async () => {
    expectGolden(golden('describe.json'), await firstValueFrom(driver.describe({ correlationId })));
  });

  it('listLanguages', async () => {
    expectGolden(golden('list-languages.json'), await firstValueFrom(driver.listLanguages({ correlationId })));
  });

  it('listPlatforms', async () => {
    expectGolden(golden('list-platforms.json'), await firstValueFrom(driver.listPlatforms({ correlationId })));
  });

  it('listCategories', async () => {
    expectGolden(golden('list-categories.json'), await firstValueFrom(driver.listCategories({ correlationId })));
  });

  // The remote DataGateway's app answered with Nest's RpcException; a
  // driver's error carries the same code and message, which is what the
  // server receives (#1082).
  it("listMechanics, which IGDB doesn't serve", async () => {
    const error = (await firstValueFrom(driver.listMechanics({ correlationId })).then(
      () => undefined,
      (err: unknown) => err,
    )) as { code: number; message: string };

    expectGolden(golden('list-mechanics-unimplemented.json'), { code: error.code, message: error.message });
  });

  it('searchGames for Hollow Knight', async () => {
    expectGolden(golden('search-hollow-knight.json'), await searched({ query: 'Hollow Knight', limit: 5 }));
  });

  it("searchGames for The Witcher 3's expansions", async () => {
    const filter: proto.SearchFilter = { platformTypes: [], contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION] };

    expectGolden(
      golden('search-witcher-3-expansions.json'),
      await searched({ query: 'The Witcher 3', limit: 5, filter }),
    );
  });

  it('fetchGame for Hollow Knight', async () => {
    expectGolden(
      golden('fetch-14593.json'),
      await firstValueFrom(driver.fetchGame({ correlationId, externalId: '14593' })),
    );
  });

  it('fetchGame for an id IGDB has no game for', async () => {
    expectGolden(
      golden('fetch-unknown.json'),
      await firstValueFrom(driver.fetchGame({ correlationId, externalId: '999999999' })),
    );
  });

  it("fetchExpansions for The Witcher 3's expansions", async () => {
    const frames = await lastValueFrom(
      driver.fetchExpansions({ correlationId, baseExternalId: '1942' }).pipe(toArray()),
    );

    expectGolden(golden('expansions-1942.json'), frames);
  });

  describe('as the driver contract asks', () => {
    it('searchGames for Hollow Knight', async () => {
      expectGolden(golden('search-hollow-knight-contract.json'), await searched({ query: 'Hollow Knight' }));
    });

    it('searchGames for Hollow Knight on its first platform type', async () => {
      const { coverage } = await firstValueFrom(driver.describe({ correlationId }));
      const filter = { platformTypes: [coverage?.platformTypes[0] as proto.PlatformType], contentTypes: [] };

      expectGolden(
        golden('search-hollow-knight-contract-platform-type.json'),
        await searched({ query: 'Hollow Knight', filter }),
      );
    });

    it('searchGames for Hollow Knight on its first content type', async () => {
      const { coverage } = await firstValueFrom(driver.describe({ correlationId }));
      const filter = { platformTypes: [], contentTypes: [coverage?.contentTypes[0] as proto.ContentType] };

      expectGolden(
        golden('search-hollow-knight-contract-content-type.json'),
        await searched({ query: 'Hollow Knight', filter }),
      );
    });

    it('searchGames for Hollow Knight published in any year', async () => {
      const filter = {
        platformTypes: [],
        contentTypes: [],
        publishYear: { includeUnknown: true, min: -10000, max: 10000 },
      };

      expectGolden(
        golden('search-hollow-knight-contract-publish-year.json'),
        await searched({ query: 'Hollow Knight', filter }),
      );
    });

    it("fetchExpansions for Hollow Knight's expansions", async () => {
      const frames = await lastValueFrom(
        driver.fetchExpansions({ correlationId, baseExternalId: '14593' }).pipe(toArray()),
      );

      expectGolden(golden('expansions-14593.json'), frames);
    });
  });
});
