import { igdbFixtureKey, type IGDBClient } from '@bge/gateway-driver-igdb';
import {
  expectGolden,
  isRecordingUpstream,
  readFixture,
  writeFixture,
} from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import type { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import igdb from 'igdb-api-node';
import { dirname, join } from 'node:path';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import type { IGDBConfig } from '../igdb/configuration/igdb.config';
import { IgdbAuthService } from '../igdb/igdb-auth.service';
import { IGDBService } from '../igdb/igdb.service';
import { TWITCH_TOKEN_URL } from '../igdb/lib/fetch-access-token';
import { DataGatewayService } from './data-gateway.service';

/**
 * What this gateway sends today for recorded IGDB answers: the parity gate
 * for moving its code into a driver library (#1082).
 *
 * The fixtures are IGDB's answers, recorded live once; each query sits
 * beside its answer in a `.apicalypse` file. To record them again, and the
 * goldens with them, run this spec with `BGE_RECORD_UPSTREAM=true`,
 * `BGE_RECORD_GOLDEN=true`, `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` set.
 */
const DRIVER_LIBRARY = dirname(require.resolve('@bge/gateway-driver-igdb/package.json'));
const FIXTURES = join(DRIVER_LIBRARY, 'src/testing/fixtures');
const GOLDEN = join(DRIVER_LIBRARY, 'src/testing/golden');

/** IGDB allows four requests a second; recording stays well under it. */
const RECORDING_PAUSE_MS = 500;

/**
 * IGDB's answer to a query, from its fixture, or from IGDB while recording.
 * `igdb-api-node` hands its options to axios, so this adapter stands in for
 * axios's own, and apicalypse still writes every query.
 */
async function fixtureAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const endpoint = config.url ?? '';
  const query = String(config.data ?? '');
  const key = igdbFixtureKey(endpoint, query);
  let text: string;

  if (isRecordingUpstream()) {
    await new Promise((resolve) => setTimeout(resolve, RECORDING_PAUSE_MS));
    const response = await fetch(`${config.baseURL}${endpoint}`, {
      method: 'POST',
      headers: config.headers.toJSON(true) as Record<string, string>,
      body: query,
    });

    text = await response.text();

    if (!response.ok) {
      throw new Error(`IGDB answered ${response.status} for ${endpoint}: ${text}`);
    }

    writeFixture(FIXTURES, `${key}.json`, text);
    writeFixture(FIXTURES, `${key}.apicalypse`, `${query}\n`);
  } else {
    text = readFixture(FIXTURES, `${key}.json`);
  }

  return { data: JSON.parse(text), status: 200, statusText: 'OK', headers: {}, config };
}

describe('IGDB gateway golden outputs', () => {
  const golden = (name: string) => join(GOLDEN, name);
  const correlationId = 'golden';
  let service: DataGatewayService;

  jest.setTimeout(isRecordingUpstream() ? 120_000 : 5_000);

  beforeAll(async () => {
    const igdbConfig: IGDBConfig = {
      clientId: isRecordingUpstream() ? (process.env.IGDB_CLIENT_ID ?? '') : 'golden-client',
      clientSecret: isRecordingUpstream() ? (process.env.IGDB_CLIENT_SECRET ?? '') : 'golden-secret',
      tokenUrl: TWITCH_TOKEN_URL,
    };

    const config = { getOrThrow: () => igdbConfig } as unknown as ConfigService;
    const auth = isRecordingUpstream()
      ? new IgdbAuthService()
      : ({
          fetchAccessToken: async () => ({ access_token: 'golden-token', expires_in: 3600, token_type: 'bearer' }),
        } as IgdbAuthService);

    const createClient = (accessToken: string) =>
      igdb(igdbConfig.clientId, accessToken, { adapter: fixtureAdapter }) as unknown as IGDBClient;

    const igdbService = new IGDBService(createClient, auth, config);
    await igdbService.onModuleInit();
    service = new DataGatewayService(igdbService);
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

  it("listMechanics, which IGDB doesn't serve", async () => {
    const error = await firstValueFrom(service.listMechanics({ correlationId })).then(
      () => undefined,
      (err: unknown) => err,
    );

    // The gateway answers with Nest's RpcException; what reaches a caller is its code and message.
    const answer = (error instanceof RpcException ? error.getError() : error) as { code: number; message: string };

    expectGolden(golden('list-mechanics-unimplemented.json'), { code: answer.code, message: answer.message });
  });

  it('searchGames for Hollow Knight', async () => {
    const frames = await lastValueFrom(
      service.searchGames({ correlationId, query: 'Hollow Knight', limit: 5 }).pipe(toArray()),
    );

    expectGolden(golden('search-hollow-knight.json'), frames);
  });

  // Hollow Knight's content packs were free updates, which search leaves out,
  // so the filtered search asks for The Witcher 3's expansions instead.
  it("searchGames for The Witcher 3's expansions", async () => {
    const filter: proto.SearchFilter = {
      platformTypes: [],
      contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION],
    };
    const frames = await lastValueFrom(
      service.searchGames({ correlationId, query: 'The Witcher 3', limit: 5, filter }).pipe(toArray()),
    );

    expectGolden(golden('search-witcher-3-expansions.json'), frames);
  });

  it('fetchGame for Hollow Knight', async () => {
    expectGolden(
      golden('fetch-14593.json'),
      await firstValueFrom(service.fetchGame({ correlationId, externalId: '14593' })),
    );
  });

  it('fetchGame for an id IGDB has no game for', async () => {
    expectGolden(
      golden('fetch-unknown.json'),
      await firstValueFrom(service.fetchGame({ correlationId, externalId: '999999999' })),
    );
  });

  it("fetchExpansions for The Witcher 3's expansions", async () => {
    const frames = await lastValueFrom(
      service.fetchExpansions({ correlationId, baseExternalId: '1942' }).pipe(toArray()),
    );

    expectGolden(golden('expansions-1942.json'), frames);
  });
});
