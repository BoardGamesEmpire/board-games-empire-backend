import type { IGDBClient } from '../igdb/interfaces';
import type { IgdbGame } from '../types';
import {
  GAME_FETCH_FIELDS,
  GAME_SEARCH_FIELDS,
  fetchExpansionsRequest,
  fetchGameRequest,
  searchGamesRequest,
} from './game.requests';

describe('GameRequests', () => {
  describe('searchGamesRequest', () => {
    it('requests the /games endpoint', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.request).toHaveBeenCalledWith('/games');
    });

    it('applies the search query', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.search).toHaveBeenCalledWith('Hades');
    });

    it('uses the default limit of 20', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.limit).toHaveBeenCalledWith(20);
    });

    it('uses the default offset of 0', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.offset).toHaveBeenCalledWith(0);
    });

    it('forwards explicit limit and offset', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades', 5, 10)(client);
      expect(client.limit).toHaveBeenCalledWith(5);
      expect(client.offset).toHaveBeenCalledWith(10);
    });

    it('excludes alternate versions via version_parent = null filter', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.where).toHaveBeenCalledWith('version_parent = null');
    });

    it('requests all GAME_SEARCH_FIELDS', async () => {
      const client = buildMockClient();
      await searchGamesRequest('Hades')(client);
      expect(client.fields).toHaveBeenCalledWith(expect.arrayContaining([...GAME_SEARCH_FIELDS]));
    });

    it('resolves with the data array from the response', async () => {
      const games: IgdbGame[] = [{ id: 1, name: 'Hades' }];
      const client = buildMockClient(games);
      const result = await searchGamesRequest('Hades')(client);
      expect(result).toEqual(games);
    });
  });

  describe('fetchGameRequest', () => {
    it('requests the /games endpoint', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.request).toHaveBeenCalledWith('/games');
    });

    it('filters by the provided externalId', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.where).toHaveBeenCalledWith(expect.stringContaining('1942'));
    });

    it('sets limit to 1', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.limit).toHaveBeenCalledWith(1);
    });

    it('requests all GAME_FETCH_FIELDS', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.fields).toHaveBeenCalledWith(expect.arrayContaining([...GAME_FETCH_FIELDS]));
    });

    it('includes involved_companies fields for publisher/developer mapping', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.fields).toHaveBeenCalledWith(
        expect.arrayContaining([
          'involved_companies.company.id',
          'involved_companies.company.name',
          'involved_companies.developer',
          'involved_companies.publisher',
        ]),
      );
    });

    it('includes genre and theme fields for category mapping', async () => {
      const client = buildMockClient();
      await fetchGameRequest('1942')(client);
      expect(client.fields).toHaveBeenCalledWith(
        expect.arrayContaining(['genres.id', 'genres.name', 'themes.id', 'themes.name']),
      );
    });

    it('resolves with the data array from the response', async () => {
      const games: IgdbGame[] = [{ id: 1942, name: 'Hades' }];
      const client = buildMockClient(games);
      const result = await fetchGameRequest('1942')(client);
      expect(result).toEqual(games);
    });
  });

  describe('fetchExpansionsRequest', () => {
    it('requests the /games endpoint', async () => {
      const client = buildMockClient();
      await fetchExpansionsRequest('1942')(client);
      expect(client.request).toHaveBeenCalledWith('/games');
    });

    it('includes parent_game filter with the baseExternalId', async () => {
      const client = buildMockClient();
      await fetchExpansionsRequest('1942')(client);
      expect(client.where).toHaveBeenCalledWith(expect.stringContaining(`parent_game = '1942'`));
    });

    it('includes version_parent filter with the baseExternalId', async () => {
      const client = buildMockClient();
      await fetchExpansionsRequest('1942')(client);
      expect(client.where).toHaveBeenCalledWith(expect.stringContaining(`version_parent = '1942'`));
    });

    it('uses an OR combinator between the two filters', async () => {
      const client = buildMockClient();
      await fetchExpansionsRequest('1942')(client);
      expect(client.where).toHaveBeenCalledWith(expect.stringContaining('|'));
    });

    it('sets a generous limit to capture all expansions', async () => {
      const client = buildMockClient();
      await fetchExpansionsRequest('1942')(client);
      // Limit should be high enough not to silently truncate prolific franchises.
      const [calledLimit] = client.limit.mock.calls[0] as [number];
      expect(calledLimit).toBeGreaterThanOrEqual(50);
    });

    it('resolves with the data array from the response', async () => {
      const games: IgdbGame[] = [{ id: 9001, name: 'DLC', game_type: 1, parent_game: { id: 1942 } }];
      const client = buildMockClient(games);
      const result = await fetchExpansionsRequest('1942')(client);
      expect(result).toEqual(games);
    });
  });
});

type MockIGDBClient = {
  [K in keyof IGDBClient]: jest.Mock;
};

function buildMockClient(results: IgdbGame[] = []): MockIGDBClient {
  const client = {
    fields: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    search: jest.fn(),
    where: jest.fn(),
    sort: jest.fn(),
    request: jest.fn<Promise<{ data: IgdbGame[] }>, [string]>().mockResolvedValue({ data: results }),
  } as MockIGDBClient;

  // All chain methods return `this` so the fluent API composes correctly.
  (Object.keys(client) as Array<keyof MockIGDBClient>).forEach((key) => {
    if (key !== 'request') {
      client[key].mockReturnValue(client);
    }
  });

  return client;
}
