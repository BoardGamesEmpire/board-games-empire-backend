import type { IGDBClient } from '../igdb/interfaces';
import { listGenresRequest, listPlatformsRequest } from './vocabulary.requests';

describe('VocabularyRequests (#718)', () => {
  describe('listPlatformsRequest', () => {
    it('asks /platforms for one page of platforms, by id, from the given offset', async () => {
      const platforms = [{ id: 6, name: 'PC (Microsoft Windows)', abbreviation: 'PC', platform_type: 6 }];
      const client = buildMockClient(platforms);

      await expect(listPlatformsRequest(500)(client)).resolves.toEqual(platforms);

      expect(client.fields).toHaveBeenCalledWith(['id', 'name', 'abbreviation', 'platform_type']);
      expect(client.sort).toHaveBeenCalledWith('id', 'asc');
      expect(client.limit).toHaveBeenCalledWith(500);
      expect(client.offset).toHaveBeenCalledWith(500);
      expect(client.request).toHaveBeenCalledWith('/platforms');
    });
  });

  describe('listGenresRequest', () => {
    it('asks /genres for one page of genres, by id, from the given offset', async () => {
      const genres = [{ id: 15, name: 'Strategy' }];
      const client = buildMockClient(genres);

      await expect(listGenresRequest(0)(client)).resolves.toEqual(genres);

      expect(client.fields).toHaveBeenCalledWith(['id', 'name']);
      expect(client.sort).toHaveBeenCalledWith('id', 'asc');
      expect(client.limit).toHaveBeenCalledWith(500);
      expect(client.offset).toHaveBeenCalledWith(0);
      expect(client.request).toHaveBeenCalledWith('/genres');
    });
  });
});

type MockIGDBClient = {
  [K in keyof IGDBClient]: jest.Mock;
};

function buildMockClient(results: unknown[] = []): MockIGDBClient {
  const client = {
    fields: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    search: jest.fn(),
    where: jest.fn(),
    sort: jest.fn(),
    request: jest.fn().mockResolvedValue({ data: results }),
  } as MockIGDBClient;

  // All chain methods return `this` so the fluent API composes correctly.
  (Object.keys(client) as Array<keyof MockIGDBClient>).forEach((key) => {
    if (key !== 'request') {
      client[key].mockReturnValue(client);
    }
  });

  return client;
}
