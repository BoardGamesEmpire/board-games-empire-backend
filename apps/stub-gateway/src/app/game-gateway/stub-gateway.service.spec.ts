import * as proto from '@boardgamesempire/proto-gateway';
import { lastValueFrom, toArray, type Observable } from 'rxjs';
import { STUB_BASE_GAME, STUB_EXPANSION, STUB_LANGUAGES } from '../fixtures/catalog';
import { StubGatewayService } from './stub-gateway.service';

const collect = <T>(source: Observable<T>) => lastValueFrom(source.pipe(toArray()));

const search = (query: string, page: { limit?: number; offset?: number } = {}) =>
  collect(new StubGatewayService().searchGames({ correlationId: 'search-1', query, ...page }));

const titlesOf = (frames: readonly proto.GatewaySearchResult[]) =>
  frames.filter((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT).map((frame) => frame.game?.title);

describe('StubGatewayService', () => {
  const service = new StubGatewayService();

  describe('ping', () => {
    it('identifies the stub and echoes the correlation id', () => {
      const before = Date.now();
      const reply = service.ping({ correlationId: 'ping-1' });

      expect(reply).toMatchObject({
        correlationId: 'ping-1',
        gatewayName: 'StubGateway',
        supportedServices: ['GatewayService'],
        languagePreferences: {
          acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
          responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
          passthroughRawLocale: false,
        },
      });
      expect(Number(reply.timestampMs)).toBeGreaterThanOrEqual(before);
      expect(Number(reply.timestampMs)).toBeLessThanOrEqual(Date.now());
    });

    it('makes up a correlation id when the request carries none', () => {
      expect(service.ping({}).correlationId).toEqual(expect.any(String));
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
