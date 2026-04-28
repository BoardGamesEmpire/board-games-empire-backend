import { firstValueFrom } from 'rxjs';
import type { BggClientLike } from '../bgg/interfaces';
import { BggThingType, DEFAULT_BGG_SEARCH_TYPES } from '../constants';
import type { BggSearchResult, BggThing } from '../types';
import { chunk, fetchThingRequest, fetchThingsRequest, parseExternalId, searchGamesRequest } from './game.requests';

describe('searchGamesRequest', () => {
  it('forwards the query text to client.search.query', async () => {
    const { client, search } = buildMockClient();

    await firstValueFrom(searchGamesRequest('Catan')(client));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Catan' }));
  });

  it('passes a single string when only one type is provided', async () => {
    const { client, search } = buildMockClient();

    await firstValueFrom(searchGamesRequest('Catan', 20, 0, [BggThingType.BoardGame])(client));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ type: BggThingType.BoardGame }));
  });

  it('passes an array when multiple types are provided', async () => {
    const { client, search } = buildMockClient();

    await firstValueFrom(searchGamesRequest('Catan')(client));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ type: [...DEFAULT_BGG_SEARCH_TYPES] }));
  });

  it('truncates the result list to the supplied limit', async () => {
    const items: BggSearchResult[] = Array.from({ length: 50 }, (_, i) => ({
      total: 50,
      items: [{ id: i + 1, type: BggThingType.BoardGame, name: `Game ${i + 1}` }],
    }));
    const { client } = buildMockClient({ searchResults: items });

    const result = await firstValueFrom(searchGamesRequest('any', 5)(client));

    expect(result).toHaveLength(5);
    expect(result[0].id).toBe(1);
    expect(result[4].id).toBe(5);
  });

  it('returns the full list when fewer items than the limit are available', async () => {
    const items: BggSearchResult[] = [
      {
        total: 2,
        items: [
          { id: 1, type: BggThingType.BoardGame, name: 'Catan' },
          { id: 2, type: BggThingType.BoardGame, name: 'Catan: Seafarers' },
        ],
      },
    ];
    const { client } = buildMockClient({ searchResults: items });

    const result = await firstValueFrom(searchGamesRequest('Catan', 10)(client));

    expect(result).toHaveLength(2);
  });

  it('is lazy — does not invoke client.search.query until subscribed', () => {
    const { client, search } = buildMockClient();

    // Construct the request and the inner Observable but never subscribe.
    searchGamesRequest('Catan')(client);

    expect(search).not.toHaveBeenCalled();
  });

  it('re-invokes client.search.query on each subscription', async () => {
    const { client, search } = buildMockClient();
    const request$ = searchGamesRequest('Catan')(client);

    await firstValueFrom(request$);
    await firstValueFrom(request$);

    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('fetchThingRequest', () => {
  it('forwards the id and stats option to client.thing.query', async () => {
    const { client, thing } = buildMockClient({
      thingResults: [{ id: 174430, type: BggThingType.BoardGame }],
    });

    await firstValueFrom(fetchThingRequest(174430, { stats: 1, types: [BggThingType.BoardGame] })(client));

    expect(thing).toHaveBeenCalledWith(expect.objectContaining({ id: 174430, stats: 1 }));
  });

  it('omits stats when not requested', async () => {
    const { client, thing } = buildMockClient();

    await firstValueFrom(fetchThingRequest(13, { types: [BggThingType.BoardGame] })(client));

    expect(thing).toHaveBeenCalledWith(expect.objectContaining({ stats: undefined }));
  });

  it('passes a single string when only one type is provided', async () => {
    const { client, thing } = buildMockClient();

    await firstValueFrom(fetchThingRequest(13, { types: [BggThingType.BoardGame] })(client));

    expect(thing).toHaveBeenCalledWith(expect.objectContaining({ type: BggThingType.BoardGame }));
  });

  it('passes an array of types when multiple are provided', async () => {
    const { client, thing } = buildMockClient();

    await firstValueFrom(
      fetchThingRequest(13, { types: [BggThingType.BoardGame, BggThingType.BoardGameExpansion] })(client),
    );

    expect(thing).toHaveBeenCalledWith(
      expect.objectContaining({ type: [BggThingType.BoardGame, BggThingType.BoardGameExpansion] }),
    );
  });

  it('returns the first thing in the result array', async () => {
    const target: BggThing = { id: 174430, type: BggThingType.BoardGame };
    const { client } = buildMockClient({ thingResults: [target] });

    const result = await firstValueFrom(fetchThingRequest(174430, { types: [BggThingType.BoardGame] })(client));

    expect(result).toBe(target);
  });

  it('returns undefined when the result array is empty', async () => {
    const { client } = buildMockClient({ thingResults: [] });

    const result = await firstValueFrom(fetchThingRequest(999999, { types: [BggThingType.BoardGame] })(client));

    expect(result).toBeUndefined();
  });

  it('is lazy — does not invoke client.thing.query until subscribed', () => {
    const { client, thing } = buildMockClient();

    fetchThingRequest(13, { types: [BggThingType.BoardGame] })(client);

    expect(thing).not.toHaveBeenCalled();
  });
});

describe('fetchThingsRequest', () => {
  it('forwards the id list to client.thing.query', async () => {
    const { client, thing } = buildMockClient();

    await firstValueFrom(fetchThingsRequest([1, 2, 3], { types: [BggThingType.BoardGameExpansion] })(client));

    expect(thing).toHaveBeenCalledWith(expect.objectContaining({ id: [1, 2, 3] }));
  });

  it('returns the full result list', async () => {
    const things: BggThing[] = [
      { id: 1, type: BggThingType.BoardGameExpansion },
      { id: 2, type: BggThingType.BoardGameExpansion },
    ];
    const { client } = buildMockClient({ thingResults: things });

    const result = await firstValueFrom(
      fetchThingsRequest([1, 2], { types: [BggThingType.BoardGameExpansion] })(client),
    );

    expect(result).toEqual(things);
  });

  it('is lazy — does not invoke client.thing.query until subscribed', () => {
    const { client, thing } = buildMockClient();

    fetchThingsRequest([1, 2], { types: [BggThingType.BoardGameExpansion] })(client);

    expect(thing).not.toHaveBeenCalled();
  });
});

describe('parseExternalId', () => {
  it('parses a valid positive integer string', () => {
    expect(parseExternalId('174430')).toBe(174430);
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseExternalId('not-a-number')).toThrow(/Invalid BGG externalId/);
  });

  it('rejects zero', () => {
    expect(() => parseExternalId('0')).toThrow();
  });

  it('rejects a negative number', () => {
    expect(() => parseExternalId('-1')).toThrow();
  });

  it('rejects a non-integer (decimal) number', () => {
    expect(() => parseExternalId('1.5')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => parseExternalId('')).toThrow();
  });
});

describe('chunk', () => {
  it('splits items into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single batch when items fit', () => {
    expect(chunk([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('throws on a non-positive size', () => {
    expect(() => chunk([1, 2], 0)).toThrow();
    expect(() => chunk([1, 2], -1)).toThrow();
  });
});

interface MockClientFixture {
  client: BggClientLike;
  thing: jest.Mock<Promise<BggThing[]>, [{ id: number | number[]; type?: string | string[]; stats?: 0 | 1 }]>;
  search: jest.Mock<Promise<BggSearchResult[]>, [{ query: string; type?: string | string[]; exact?: 0 | 1 }]>;
}

function buildMockClient(options?: {
  thingResults?: BggThing[];
  searchResults?: BggSearchResult[];
}): MockClientFixture {
  const thing = jest.fn<Promise<BggThing[]>, [{ id: number | number[]; type?: string | string[]; stats?: 0 | 1 }]>();
  const search = jest.fn<Promise<BggSearchResult[]>, [{ query: string; type?: string | string[]; exact?: 0 | 1 }]>();

  thing.mockResolvedValue(options?.thingResults ?? []);
  search.mockResolvedValue(options?.searchResults ?? []);

  return {
    client: { thing: { query: thing }, search: { query: search } },
    thing,
    search,
  };
}
