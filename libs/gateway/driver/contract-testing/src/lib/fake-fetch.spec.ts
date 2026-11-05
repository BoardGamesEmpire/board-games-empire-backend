import { createFakeFetch, neverReply } from './fake-fetch.js';

/**
 * A stand-in for the fetch a driver is given, which records what the driver
 * asked its upstream for (#1082).
 */
describe('createFakeFetch', () => {
  it('records the URL, method, headers and body of each request', async () => {
    const fetch = createFakeFetch(() => ({ body: '[]' }));

    await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'client-id': 'id', accept: 'application/json' },
      body: 'fields id;',
    });

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]).toMatchObject({
      method: 'POST',
      headers: { 'client-id': 'id', accept: 'application/json' },
      body: 'fields id;',
    });
    expect(fetch.requests[0].url.href).toBe('https://api.igdb.com/v4/games');
  });

  it('answers with the reply, 200 OK unless it says otherwise', async () => {
    const ok = createFakeFetch(() => ({ body: '<items/>' }));
    const failing = createFakeFetch(async () => ({
      status: 502,
      statusText: 'Bad Gateway',
      body: '<html>Bad Gateway</html>',
      headers: { 'content-type': 'text/html' },
    }));

    const answered = await ok('https://boardgamegeek.com/xmlapi2/thing?id=1', { method: 'GET', headers: {} });
    const failed = await failing('https://boardgamegeek.com/xmlapi2/thing?id=1', { method: 'GET', headers: {} });

    expect([answered.status, answered.statusText, await answered.text()]).toEqual([200, 'OK', '<items/>']);
    expect([failed.status, failed.statusText, failed.headers.get('content-type')]).toEqual([
      502,
      'Bad Gateway',
      'text/html',
    ]);
  });

  it('rejects with an AbortError when the request is aborted while its reply is pending', async () => {
    const fetch = createFakeFetch(() => neverReply());
    const controller = new AbortController();

    const pending = fetch('https://boardgamegeek.com/xmlapi2/thing?id=1', {
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.requests[0].signal?.aborted).toBe(true);
  });

  it('rejects at once with an AbortError when the request was aborted before it was made', async () => {
    const respond = jest.fn(() => ({ body: '' }));
    const fetch = createFakeFetch(respond);

    await expect(
      fetch('https://boardgamegeek.com/xmlapi2/thing?id=1', {
        method: 'GET',
        headers: {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(respond).not.toHaveBeenCalled();
  });
});
