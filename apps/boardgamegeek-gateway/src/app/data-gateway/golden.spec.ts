import { bggFixtureKey } from '@bge/gateway-driver-boardgamegeek';
import {
  expectGolden,
  isRecordingUpstream,
  readFixture,
  writeFixture,
} from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { BggClient } from 'bgg-ts-client';
import { dirname, join } from 'node:path';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { adaptBggTsClient } from '../bgg/bgg-ts-client.adapter';
import { BggService } from '../bgg/bgg.service';
import { DataGatewayService } from './data-gateway.service';

/**
 * What this gateway sends today for recorded BGG answers: the parity gate
 * for moving its code into a driver library (#1082).
 *
 * The fixtures are BGG's answers, recorded live once. To record them again,
 * and the goldens with them, run this spec with `BGE_RECORD_UPSTREAM=true`,
 * `BGE_RECORD_GOLDEN=true` and `BOARDGAMEGEEK_API_KEY` set.
 */
const DRIVER_LIBRARY = dirname(require.resolve('@bge/gateway-driver-boardgamegeek/package.json'));
const FIXTURES = join(DRIVER_LIBRARY, 'src/testing/fixtures');
const GOLDEN = join(DRIVER_LIBRARY, 'src/testing/golden');

/** BGG asks for a pause between calls; recording keeps to it, so a 429 can't end up in a golden. */
const RECORDING_PAUSE_MS = 2500;

/**
 * BGG's answer to a request, from its fixture, or from BGG while recording.
 * `bgg-ts-client` fetches through `isomorphic-unfetch`, so this stands in
 * for it, and the client's own code still builds every URL.
 */
const mockFixtureFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const name = `${bggFixtureKey(url)}.xml`;

  if (!isRecordingUpstream()) {
    return new Response(readFixture(FIXTURES, name), { status: 200 });
  }

  await new Promise((resolve) => setTimeout(resolve, RECORDING_PAUSE_MS));
  const response = await fetch(url, init);
  const body = await response.text();

  // A 202 means BGG is still preparing the answer: the client asks again.
  if (response.status === 200) {
    writeFixture(FIXTURES, name, body);
  }

  return new Response(body, { status: response.status });
};

jest.mock('isomorphic-unfetch', () => (url: string, init?: RequestInit) => mockFixtureFetch(url, init));

describe('BoardGameGeek gateway golden outputs', () => {
  const golden = (name: string) => join(GOLDEN, name);
  const correlationId = 'golden';
  let service: DataGatewayService;

  jest.setTimeout(isRecordingUpstream() ? 120_000 : 5_000);

  beforeAll(() => {
    const apiKey = isRecordingUpstream() ? (process.env.BOARDGAMEGEEK_API_KEY ?? '') : 'golden-key';
    // As BggModule provides it.
    service = new DataGatewayService(new BggService(adaptBggTsClient(BggClient.Create({ apiKey }))));
  });

  // Ping's timestamp changes on every call, so ping has no golden.

  it('describe', () => {
    expectGolden(golden('describe.json'), service.describe({ correlationId }));
  });

  it('listLanguages', () => {
    expectGolden(golden('list-languages.json'), service.listLanguages({ correlationId }));
  });

  it('listPlatforms', async () => {
    expectGolden(golden('list-platforms.json'), await firstValueFrom(service.listPlatforms({ correlationId })));
  });

  it('listCategories', async () => {
    expectGolden(golden('list-categories.json'), await firstValueFrom(service.listCategories({ correlationId })));
  });

  it('listMechanics', async () => {
    expectGolden(golden('list-mechanics.json'), await firstValueFrom(service.listMechanics({ correlationId })));
  });

  it("searchGames for Tzolk'in", async () => {
    const frames = await lastValueFrom(
      service.searchGames({ correlationId, query: "Tzolk'in", limit: 5 }).pipe(toArray()),
    );

    expectGolden(golden('search-tzolkin.json'), frames);
  });

  it("searchGames for Tzolk'in's expansions", async () => {
    const filter: proto.SearchFilter = {
      platformTypes: [],
      contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION],
    };
    const frames = await lastValueFrom(
      service.searchGames({ correlationId, query: "Tzolk'in", limit: 5, filter }).pipe(toArray()),
    );

    expectGolden(golden('search-tzolkin-expansions.json'), frames);
  });

  it("fetchGame for Tzolk'in", async () => {
    expectGolden(
      golden('fetch-126163.json'),
      await firstValueFrom(service.fetchGame({ correlationId, externalId: '126163' })),
    );
  });

  it('fetchGame for an id BGG has no game for', async () => {
    expectGolden(
      golden('fetch-unknown.json'),
      await firstValueFrom(service.fetchGame({ correlationId, externalId: '999999999' })),
    );
  });

  it("fetchExpansions for Tzolk'in", async () => {
    const frames = await lastValueFrom(
      service.fetchExpansions({ correlationId, baseExternalId: '126163' }).pipe(toArray()),
    );

    expectGolden(golden('expansions-126163.json'), frames);
  });
});
