import { BggThingType, fetchThingRequest, searchGamesRequest } from '@bge/gateway-driver-boardgamegeek';
import { BggClient } from 'bgg-ts-client';
import { firstValueFrom } from 'rxjs';
import { adaptBggTsClient } from './bgg-ts-client.adapter';

/** The network under the real bgg-ts-client, which fetches through isomorphic-unfetch. */
const mockFetch = jest.fn<Promise<Response>, [string]>();
jest.mock('isomorphic-unfetch', () => (url: string) => mockFetch(url));

const client = adaptBggTsClient(BggClient.Create({ apiKey: 'test-key' }));

afterEach(() => mockFetch.mockReset());

// The request builders and mappers now take BGG's text as text, as the
// driver's own client hands it over (#863, #1082). Until the app hosts the
// driver, this adapter makes bgg-ts-client hand it over the same way.
describe('adaptBggTsClient', () => {
  // bgg-ts-client joins parameters into the URL unencoded, and the request
  // builders hand over the query as typed (#969).
  it('sends a search query in the URL so that BGG reads it as typed', async () => {
    mockFetch.mockImplementation(async () => new Response('<items total="0" termsofuse=""></items>'));

    for (const query of ['Dungeons & Dragons', '1+1', '#']) {
      mockFetch.mockClear();

      await expect(firstValueFrom(searchGamesRequest(query)(client))).resolves.toEqual([]);

      expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get('query')).toBe(query);
    }
  });

  it('hands over as text what bgg-ts-client parsed as a number or a boolean', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          '<?xml version="1.0" encoding="utf-8"?><items termsofuse=""><item type="boardgame" id="1">' +
            '<name type="primary" sortindex="1" value="2048"/><name type="alternate" sortindex="1" value="true"/>' +
            '<description>1830</description>' +
            '<link type="boardgameexpansion" id="5" value="1830" inbound="true"/></item></items>',
        ),
    );

    const thing = await firstValueFrom(fetchThingRequest(1, { types: [BggThingType.BoardGame] })(client));

    expect(thing).toMatchObject({
      id: 1,
      name: '2048',
      alternateNames: ['2048', 'true'],
      description: '1830',
      links: [{ type: 'boardgameexpansion', id: 5, value: '1830', inbound: 'true' }],
    });
  });
});
