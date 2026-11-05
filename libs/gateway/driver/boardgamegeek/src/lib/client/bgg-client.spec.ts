import { createFakeFetch, type FakeFetchReply } from '@boardgamesempire/gateway-driver-contract-testing';
import { createBggClient } from './bgg-client';
import { BggHttpError } from './bgg-http.error';

const NO_THINGS = '<?xml version="1.0" encoding="utf-8"?><items termsofuse=""></items>';
const NO_RESULTS = '<?xml version="1.0" encoding="utf-8"?><items total="0" termsofuse=""></items>';
const STILL_PREPARING: FakeFetchReply = { status: 202, statusText: 'Accepted', body: '' };

/** Lets pending promise callbacks run, so a request the client is about to make gets made. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * BGG's own client, on the fetch the driver is handed: the plugin form passes
 * a scoped HTTP client, so the client never reaches BGG by itself (#1082).
 */
describe('createBggClient', () => {
  it('asks /thing with the API key, each parameter in the order given', async () => {
    const fetch = createFakeFetch(() => ({ body: NO_THINGS }));
    const client = createBggClient({ fetch, apiKey: 'key-1' });

    await client.thing.query({ id: [1, 2], type: ['boardgame', 'boardgameexpansion'], stats: 1, versions: 0 });

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].method).toBe('GET');
    expect(fetch.requests[0].url.href).toBe(
      'https://boardgamegeek.com/xmlapi2/thing?id=1,2&type=boardgame,boardgameexpansion&stats=1&versions=0',
    );
    expect(fetch.requests[0].headers).toEqual({ Authorization: 'Bearer key-1' });
  });

  it('leaves out a parameter that has no value', async () => {
    const fetch = createFakeFetch(() => ({ body: NO_THINGS }));

    await createBggClient({ fetch, apiKey: 'key' }).thing.query({ id: 7, type: 'boardgame', stats: undefined });

    expect(fetch.requests[0].url.search).toBe('?id=7&type=boardgame');
  });

  // The old client joined values into the URL unencoded, so a & split the
  // query and a # cut it off (#969).
  it('sends a search query as one value, whatever characters it holds', async () => {
    const fetch = createFakeFetch(() => ({ body: NO_RESULTS }));
    const client = createBggClient({ fetch, apiKey: 'key' });

    for (const query of ['Ticket to Ride: Europe & More', "Tzolk'in", '1+1 = "2" #', 'Ōkami, 大神']) {
      await client.search.query({ query, type: ['boardgame'] });
    }

    expect(fetch.requests.map(({ url }) => url.searchParams.get('query'))).toEqual([
      'Ticket to Ride: Europe & More',
      "Tzolk'in",
      '1+1 = "2" #',
      'Ōkami, 大神',
    ]);
  });

  it('reads the search answer it gets', async () => {
    const fetch = createFakeFetch(() => ({ body: NO_RESULTS }));

    await expect(createBggClient({ fetch, apiKey: 'key' }).search.query({ query: 'nothing' })).resolves.toEqual([
      { total: 0, items: undefined },
    ]);
  });

  describe('when BGG answers 202, still preparing the answer', () => {
    it('asks again until it has the answer', async () => {
      const replies = [STILL_PREPARING, STILL_PREPARING, { body: NO_THINGS }];
      const fetch = createFakeFetch(() => replies.shift() ?? { body: NO_THINGS });

      await expect(
        createBggClient({ fetch, apiKey: 'key', acceptedRetryMs: 1 }).thing.query({ id: 1 }),
      ).resolves.toEqual([]);

      expect(fetch.requests).toHaveLength(3);
    });

    it('gives up after five more tries', async () => {
      const fetch = createFakeFetch(() => STILL_PREPARING);

      await expect(
        createBggClient({ fetch, apiKey: 'key', acceptedRetryMs: 1 }).thing.query({ id: 1 }),
      ).rejects.toThrow('BGG API still processing after 5 retries');

      expect(fetch.requests).toHaveLength(6);
    });

    // A cancelled call stops reaching BGG, even between tries (#1082).
    it('asks no more once the call is aborted while it waits', async () => {
      const fetch = createFakeFetch(() => STILL_PREPARING);
      const controller = new AbortController();

      const answer = createBggClient({ fetch, apiKey: 'key', acceptedRetryMs: 60_000 }).thing.query(
        { id: 1 },
        controller.signal,
      );
      await settle();
      controller.abort();

      await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
      await settle();
      expect(fetch.requests).toHaveLength(1);
    });
  });

  // A proxy in front of BGG can answer with an HTML page. It becomes an error
  // naming the status, never a parse failure (#1082).
  it('fails with the status when BGG answers with an error page', async () => {
    const fetch = createFakeFetch(() => ({
      status: 502,
      statusText: 'Bad Gateway',
      body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      headers: { 'content-type': 'text/html' },
    }));

    const failure = await createBggClient({ fetch, apiKey: 'key' })
      .thing.query({ id: 1 })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(BggHttpError);
    expect(failure).toMatchObject({
      status: 502,
      url: 'https://boardgamegeek.com/xmlapi2/thing?id=1',
      message: 'BGG answered 502 for https://boardgamegeek.com/xmlapi2/thing',
    });
  });

  it("carries a 429's Retry-After, given in seconds", async () => {
    const fetch = createFakeFetch(() => ({
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '3' },
    }));

    await expect(createBggClient({ fetch, apiKey: 'key' }).thing.query({ id: 1 })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 3000,
    });
  });
});
