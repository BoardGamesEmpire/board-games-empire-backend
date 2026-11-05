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
import { BoardGameGeekDriver } from './boardgamegeek.driver';
import { bggFixtureFetch } from './testing/bgg-fixture-fetch';
import { bggFixtureKey } from './testing/bgg-fixture-key';

/**
 * The driver sends what the BoardGameGeek remote DataGateway sent before its
 * code moved here: the goldens were recorded from its app, over the same
 * upstream fixtures, with the same requests (#1082).
 *
 * The one intended difference is #863's: text the old parser turned into a
 * number now arrives as BGG sent it. Tzolk'in's fixtures hold no such text,
 * so no golden differs.
 *
 * To record the goldens again from this driver, run this spec with
 * `BGE_RECORD_GOLDEN=true`, then review the diff. To record BGG's answers
 * again too, add `BGE_RECORD_UPSTREAM=true` and `BOARDGAMEGEEK_API_KEY`: the
 * driver then asks BGG itself, through a recording fetch.
 */
const TESTING = join(__dirname, '..', 'testing');
const FIXTURES = join(TESTING, 'fixtures');
const golden = (name: string) => join(TESTING, 'golden', name);

/** BGG asks for a pause between calls; recording keeps to it, so a 429 can't end up in a golden (#1082). */
const RECORDING_PAUSE_MS = 2500;

const paced: UpstreamFetch = async (url, request) => {
  await new Promise((resolve) => setTimeout(resolve, RECORDING_PAUSE_MS));
  return fetch(url, request);
};

/** BGG's recorded answers, or BGG itself while recording, each answer kept as its fixture. */
const upstream = (): UpstreamFetch =>
  isRecordingUpstream()
    ? createRecordingFetch(({ url }, body) => writeFixture(FIXTURES, `${bggFixtureKey(url)}.xml`, body), paced)
    : bggFixtureFetch(FIXTURES);

const silent: DriverLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("BoardGameGeekDriver matches the BoardGameGeek remote DataGateway's recorded output", () => {
  const correlationId = 'golden';
  const driver = new BoardGameGeekDriver({
    fetch: upstream(),
    apiKey: isRecordingUpstream() ? (process.env.BOARDGAMEGEEK_API_KEY ?? '') : 'golden-key',
    version: '0.0.0-golden',
    logger: silent,
  });

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

  it('listMechanics', async () => {
    expectGolden(golden('list-mechanics.json'), await firstValueFrom(driver.listMechanics({ correlationId })));
  });

  it("searchGames for Tzolk'in", async () => {
    const frames = await lastValueFrom(
      driver.searchGames({ correlationId, query: "Tzolk'in", limit: 5 }).pipe(toArray()),
    );

    expectGolden(golden('search-tzolkin.json'), frames);
  });

  it("searchGames for Tzolk'in's expansions", async () => {
    const filter: proto.SearchFilter = {
      platformTypes: [],
      contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION],
    };
    const frames = await lastValueFrom(
      driver.searchGames({ correlationId, query: "Tzolk'in", limit: 5, filter }).pipe(toArray()),
    );

    expectGolden(golden('search-tzolkin-expansions.json'), frames);
  });

  it("fetchGame for Tzolk'in", async () => {
    expectGolden(
      golden('fetch-126163.json'),
      await firstValueFrom(driver.fetchGame({ correlationId, externalId: '126163' })),
    );
  });

  it('fetchGame for an id BGG has no game for', async () => {
    expectGolden(
      golden('fetch-unknown.json'),
      await firstValueFrom(driver.fetchGame({ correlationId, externalId: '999999999' })),
    );
  });

  it("fetchExpansions for Tzolk'in", async () => {
    const frames = await lastValueFrom(
      driver.fetchExpansions({ correlationId, baseExternalId: '126163' }).pipe(toArray()),
    );

    expectGolden(golden('expansions-126163.json'), frames);
  });
});
