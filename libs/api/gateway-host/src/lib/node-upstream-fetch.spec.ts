import { nodeUpstreamFetch } from './node-upstream-fetch';

/** A remote DataGateway's app hands its driver Node's own fetch (#1082). */
describe('nodeUpstreamFetch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the request through Node’s fetch, as it was given', async () => {
    const answer = new Response('[]');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer);
    const signal = new AbortController().signal;

    const response = await nodeUpstreamFetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: 'fields id;',
      signal,
    });

    expect(response).toBe(answer);
    expect(fetch).toHaveBeenCalledWith('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: 'fields id;',
      signal,
    });
  });
});
