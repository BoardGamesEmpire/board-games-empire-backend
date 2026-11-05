import { createFakeFetch, neverReply } from '@boardgamesempire/gateway-driver-contract-testing';
import { fetchAccessToken } from './fetch-access-token';

const TOKEN = JSON.stringify({ access_token: 'stub-token', expires_in: 3600, token_type: 'bearer' });

/** The token comes through the fetch the driver is handed, like every other upstream call (#1082). */
describe('fetchAccessToken', () => {
  const credentials = { client_id: 'test-client-id', client_secret: 'test-secret' };

  it('requests a client-credentials token from the URL it is given', async () => {
    const fetch = createFakeFetch(() => ({ body: TOKEN }));

    const token = await fetchAccessToken(fetch, credentials, 'http://127.0.0.1:4010/oauth2/token');

    expect(token.access_token).toBe('stub-token');
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].method).toBe('POST');
    expect(`${fetch.requests[0].url.origin}${fetch.requests[0].url.pathname}`).toBe(
      'http://127.0.0.1:4010/oauth2/token',
    );
    expect(Object.fromEntries(fetch.requests[0].url.searchParams)).toEqual({
      client_id: 'test-client-id',
      client_secret: 'test-secret',
      grant_type: 'client_credentials',
    });
  });

  it('keeps a query the URL it is given already carries', async () => {
    const fetch = createFakeFetch(() => ({ body: TOKEN }));

    await fetchAccessToken(fetch, credentials, 'http://127.0.0.1:4010/oauth2/token?tenant=a');

    expect(Object.fromEntries(fetch.requests[0].url.searchParams)).toEqual({
      tenant: 'a',
      client_id: 'test-client-id',
      client_secret: 'test-secret',
      grant_type: 'client_credentials',
    });
  });

  it("requests from Twitch's endpoint when given no URL", async () => {
    const fetch = createFakeFetch(() => ({ body: TOKEN }));

    await fetchAccessToken(fetch, credentials);

    const { url } = fetch.requests[0];
    expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/token');
  });

  it('fails with the status when the endpoint refuses', async () => {
    const fetch = createFakeFetch(() => ({ status: 503, statusText: 'Service Unavailable' }));

    await expect(fetchAccessToken(fetch, credentials, 'http://127.0.0.1:4010/oauth2/token')).rejects.toThrow(
      'Failed to obtain IGDB access token: 503 Service Unavailable',
    );
  });

  // A token endpoint that takes the connection and never answers would hold
  // the gateway's boot, and every call waiting on a refresh, forever (#1082).
  it('fails, and stops the request, when the endpoint has not answered in time', async () => {
    const fetch = createFakeFetch(neverReply);

    await expect(fetchAccessToken(fetch, credentials, 'http://127.0.0.1:4010/oauth2/token', 20)).rejects.toThrow(
      'Failed to obtain IGDB access token: no answer within 20ms',
    );
    expect(fetch.requests[0].signal?.aborted).toBe(true);
  });
});
