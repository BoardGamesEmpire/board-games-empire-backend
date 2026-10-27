import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { lastValueFrom, toArray, type Observable } from 'rxjs';
import {
  STUB_BASE_GAME,
  STUB_CATEGORIES,
  STUB_EXPANSION,
  STUB_GAMES,
  STUB_LANGUAGES,
  STUB_MECHANICS,
  STUB_PLATFORMS,
} from '../fixtures/catalog';
import { StubGatewayService } from './stub-gateway.service';

const collect = <T>(source: Observable<T>) => lastValueFrom(source.pipe(toArray()));

const search = (query: string, options: { limit?: number; offset?: number; filter?: proto.SearchFilter } = {}) =>
  collect(new StubGatewayService().searchGames({ correlationId: 'search-1', query, ...options }));

const titlesOf = (frames: readonly proto.GatewaySearchResult[]) =>
  frames.filter((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT).map((frame) => frame.game?.title);

describe('StubGatewayService', () => {
  const service = new StubGatewayService();

  describe('ping', () => {
    it('identifies the stub and echoes the correlation id', () => {
      const before = Date.now();
      const reply = service.ping({ correlationId: 'ping-1' });

      expect(reply).toMatchObject({ correlationId: 'ping-1', gatewayName: 'StubGateway' });
      expect(Number(reply.timestampMs)).toBeGreaterThanOrEqual(before);
      expect(Number(reply.timestampMs)).toBeLessThanOrEqual(Date.now());
    });

    it('makes up a correlation id when the request carries none', () => {
      expect(service.ping({}).correlationId).toEqual(expect.any(String));
    });

    it('reports the product version it was built at', () => {
      expect(service.ping({}).gatewayVersion).toBe(BGE_VERSION);
    });
  });

  describe('describe', () => {
    it('declares every operation, tabletop base games and expansions, BCP 47 tags and plain text', () => {
      expect(service.describe({ correlationId: 'describe-1' })).toEqual({
        correlationId: 'describe-1',
        capabilities: [
          proto.Capability.CAPABILITY_SEARCH,
          proto.Capability.CAPABILITY_FETCH,
          proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
          proto.Capability.CAPABILITY_LIST_LANGUAGES,
          proto.Capability.CAPABILITY_LIST_PLATFORMS,
          proto.Capability.CAPABILITY_LIST_CATEGORIES,
          proto.Capability.CAPABILITY_LIST_MECHANICS,
        ],
        coverage: {
          platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
          contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_EXPANSION],
        },
        // Not play time, so the e2e suites cover a DataGateway a play-time search skips (#869).
        filterableAxes: [
          proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
          proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
          proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLAYER_COUNT,
        ],
        languageCodeFormats: {
          acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
          responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
          passthroughSearchLanguage: false,
        },
        contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
      } satisfies proto.DescribeResponse);
    });

    it('covers every game it serves', () => {
      const { coverage } = service.describe({});

      for (const game of STUB_GAMES) {
        expect(coverage?.contentTypes).toContain(game.contentType);
        for (const platform of game.platforms) {
          expect(coverage?.platformTypes).toContain(platform.platformType);
        }
      }
    });

    it('makes up a correlation id when the request carries none', () => {
      expect(service.describe({}).correlationId).toEqual(expect.any(String));
    });
  });

  it('reports itself SERVING', () => {
    expect(service.healthCheck()).toEqual({
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    });
  });

  describe('listLanguages', () => {
    it('lists its languages by BCP 47 tag', () => {
      expect(service.listLanguages({ correlationId: 'languages-1' })).toEqual({
        correlationId: 'languages-1',
        languages: STUB_LANGUAGES,
      });
    });

    it('makes up a correlation id when the request carries none', () => {
      expect(service.listLanguages({}).correlationId).toEqual(expect.any(String));
    });
  });

  // The stub serves every list, so each list job runs in the e2e suites (#718).
  describe('the vocabulary lists (#718)', () => {
    it('lists its platforms, categories and mechanics', async () => {
      await expect(lastValueFrom(service.listPlatforms({ correlationId: 'platforms-1' }))).resolves.toEqual({
        correlationId: 'platforms-1',
        platforms: STUB_PLATFORMS,
      });
      await expect(lastValueFrom(service.listCategories({ correlationId: 'categories-1' }))).resolves.toEqual({
        correlationId: 'categories-1',
        categories: STUB_CATEGORIES,
      });
      await expect(lastValueFrom(service.listMechanics({ correlationId: 'mechanics-1' }))).resolves.toEqual({
        correlationId: 'mechanics-1',
        mechanics: STUB_MECHANICS,
      });
    });

    it('lists every platform, category and mechanic its games carry', () => {
      for (const game of STUB_GAMES) {
        expect(STUB_PLATFORMS).toEqual(expect.arrayContaining(game.platforms));
        expect(STUB_CATEGORIES).toEqual(expect.arrayContaining(game.categories));
        expect(STUB_MECHANICS).toEqual(expect.arrayContaining(game.mechanics));
      }
    });
  });

  describe('searchGames', () => {
    it('streams each game whose title contains the query, ignoring case, then SOURCE_DONE', async () => {
      const frames = await search('ISLAND');

      expect(titlesOf(frames)).toEqual([STUB_BASE_GAME.title, STUB_EXPANSION.title]);
      expect(frames.at(-1)).toEqual({
        correlationId: 'search-1',
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      });
      expect(frames.every((frame) => frame.correlationId === 'search-1')).toBe(true);
    });

    it('answers a search that matches nothing with SOURCE_DONE alone', async () => {
      await expect(search('no such game')).resolves.toEqual([
        { correlationId: 'search-1', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
      ]);
    });

    it('narrows the matches to the content types its filter names, before paging', async () => {
      const expansions = { platformTypes: [], contentTypes: [proto.ContentType.CONTENT_TYPE_EXPANSION] };

      await expect(search('island', { filter: expansions }).then(titlesOf)).resolves.toEqual([STUB_EXPANSION.title]);
      await expect(search('island', { filter: expansions, limit: 1 }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
    });

    // So the e2e suites cover a DataGateway the server sends a range to (#719).
    it('narrows its fixtures by publish year, both bounds inclusive, before paging', async () => {
      const byYear = (publishYear: proto.IntRange) => ({ platformTypes: [], contentTypes: [], publishYear });

      await expect(search('island', { filter: byYear({ min: 2021 }) }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byYear({ min: 2020, max: 2020 }) }).then(titlesOf)).resolves.toEqual([
        STUB_BASE_GAME.title,
      ]);
      await expect(search('island', { filter: byYear({ min: 2021 }), limit: 1 }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byYear({ max: 1999 }) }).then(titlesOf)).resolves.toEqual([]);
    });

    // A bound alone is one count, so a minimum of 5 means "supports 5" (#869).
    it('narrows its fixtures to the games that support every player count in the range, before paging', async () => {
      const byCount = (playerCount: proto.IntRange) => ({ platformTypes: [], contentTypes: [], playerCount });

      await expect(search('island', { filter: byCount({ min: 5 }) }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byCount({ max: 5 }) }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byCount({ min: 2, max: 4 }) }).then(titlesOf)).resolves.toEqual([
        STUB_BASE_GAME.title,
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byCount({ min: 5 }), limit: 1 }).then(titlesOf)).resolves.toEqual([
        STUB_EXPANSION.title,
      ]);
      await expect(search('island', { filter: byCount({ min: 1 }) }).then(titlesOf)).resolves.toEqual([]);
    });

    // It doesn't declare play time, so the server checks the play times its results carry (#869).
    it('ignores a play-time range, which it doesn’t narrow by', async () => {
      const short = { platformTypes: [], contentTypes: [], playTime: { max: 10 } };

      await expect(search('island', { filter: short }).then(titlesOf)).resolves.toEqual([
        STUB_BASE_GAME.title,
        STUB_EXPANSION.title,
      ]);
    });

    it('ignores platform types, which it doesn’t narrow by', async () => {
      const pc = { platformTypes: [proto.PlatformType.PLATFORM_TYPE_PC], contentTypes: [] };

      await expect(search('island', { filter: pc }).then(titlesOf)).resolves.toEqual([
        STUB_BASE_GAME.title,
        STUB_EXPANSION.title,
      ]);
    });

    it('pages the matches by offset and limit', async () => {
      await expect(search('island', { offset: 1, limit: 1 }).then(titlesOf)).resolves.toEqual([STUB_EXPANSION.title]);
      await expect(search('island', { limit: 1 }).then(titlesOf)).resolves.toEqual([STUB_BASE_GAME.title]);
    });

    it('describes a match as its fetched game does', async () => {
      const [first] = await search(STUB_BASE_GAME.title);

      expect(first.game).toMatchObject({
        externalId: STUB_BASE_GAME.externalId,
        title: STUB_BASE_GAME.title,
        contentType: STUB_BASE_GAME.contentType,
        yearPublished: STUB_BASE_GAME.yearPublished,
        minPlayers: STUB_BASE_GAME.minPlayers,
        maxPlayers: STUB_BASE_GAME.maxPlayers,
        minPlaytime: STUB_BASE_GAME.minPlaytime,
        maxPlaytime: STUB_BASE_GAME.maxPlaytime,
        availablePlatforms: STUB_BASE_GAME.platforms,
      });
    });
  });

  describe('fetchGame', () => {
    it('returns the game the external id names', async () => {
      await expect(
        lastValueFrom(service.fetchGame({ correlationId: 'fetch-1', externalId: STUB_BASE_GAME.externalId })),
      ).resolves.toEqual({
        correlationId: 'fetch-1',
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: STUB_BASE_GAME,
      });
    });

    it('answers an external id it does not know with an ERROR, as the real gateways do', async () => {
      await expect(
        lastValueFrom(service.fetchGame({ correlationId: 'fetch-2', externalId: 'stub-0' })),
      ).resolves.toEqual({
        correlationId: 'fetch-2',
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: "No game found for externalId 'stub-0'",
      });
    });
  });

  describe('fetchExpansions', () => {
    it("streams the base game's expansions, then SOURCE_DONE", async () => {
      const frames = await collect(
        service.fetchExpansions({ correlationId: 'expansions-1', baseExternalId: STUB_BASE_GAME.externalId }),
      );

      expect(titlesOf(frames)).toEqual([STUB_EXPANSION.title]);
      expect(frames[0].game?.baseGameExternalId).toBe(STUB_BASE_GAME.externalId);
      expect(frames.at(-1)?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('answers a game with no expansions with SOURCE_DONE alone', async () => {
      await expect(
        collect(service.fetchExpansions({ correlationId: 'expansions-2', baseExternalId: STUB_EXPANSION.externalId })),
      ).resolves.toEqual([{ correlationId: 'expansions-2', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE }]);
    });
  });
});
