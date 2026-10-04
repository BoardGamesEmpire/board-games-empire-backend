import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchAccessToken } from './fetch-access-token';

/** A local token endpoint that records each request and answers with `status`. */
async function startTokenEndpoint(status: number) {
  const requests: { method?: string; url?: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600, token_type: 'bearer' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/oauth2/token`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('fetchAccessToken', () => {
  const credentials = { client_id: 'test-client-id', client_secret: 'test-secret' };

  it('requests a client-credentials token from the URL it is given', async () => {
    const endpoint = await startTokenEndpoint(200);

    try {
      const token = await fetchAccessToken(credentials, endpoint.url);

      expect(token.access_token).toBe('stub-token');
      expect(endpoint.requests).toHaveLength(1);
      expect(endpoint.requests[0].method).toBe('POST');

      const query = new URL(endpoint.requests[0].url ?? '', endpoint.url).searchParams;
      expect(Object.fromEntries(query)).toEqual({
        client_id: 'test-client-id',
        client_secret: 'test-secret',
        grant_type: 'client_credentials',
      });
    } finally {
      await endpoint.close();
    }
  });

  it('keeps a query the URL it is given already carries', async () => {
    const endpoint = await startTokenEndpoint(200);

    try {
      await fetchAccessToken(credentials, `${endpoint.url}?tenant=a`);

      const query = new URL(endpoint.requests[0].url ?? '', endpoint.url).searchParams;
      expect(Object.fromEntries(query)).toEqual({
        tenant: 'a',
        client_id: 'test-client-id',
        client_secret: 'test-secret',
        grant_type: 'client_credentials',
      });
    } finally {
      await endpoint.close();
    }
  });

  it("requests from Twitch's endpoint when given no URL", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'stub-token' })));

    try {
      await fetchAccessToken(credentials);

      const url = new URL(String(fetchSpy.mock.calls[0][0]));
      expect(`${url.origin}${url.pathname}`).toBe('https://id.twitch.tv/oauth2/token');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails with the status when the endpoint refuses', async () => {
    const endpoint = await startTokenEndpoint(400);

    try {
      await expect(fetchAccessToken(credentials, endpoint.url)).rejects.toThrow(/400/);
    } finally {
      await endpoint.close();
    }
  });
});
