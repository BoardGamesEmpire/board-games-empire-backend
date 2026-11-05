import { createFakeFetch, neverReply } from '@boardgamesempire/gateway-driver-contract-testing';
import { IgdbHttpError } from './igdb-http.error';
import { IgdbQuery } from './igdb-query';

const query = (fetch = createFakeFetch(() => ({ body: '[]' }))) =>
  new IgdbQuery({ fetch, clientId: 'client-1', accessToken: 't' });

/**
 * IGDB's queries, written as apicalypse 1.x wrote them for igdb-api-node, so
 * IGDB is asked exactly what it was asked before, over the fetch the driver
 * is handed (#1082).
 */
describe('IgdbQuery', () => {
  it("writes each clause in the order it's given, where clauses last, and leaves out a zero offset", async () => {
    const fetch = createFakeFetch(() => ({ body: '[]' }));

    await query(fetch).fields(['a', 'b c']).search('q').where(' id = 1 ').limit(20).offset(0).request('/games');

    expect(fetch.requests[0].body).toBe('fields a,bc;search "q";limit 20;where id = 1;');
  });

  it('sorts ascending unless told otherwise, and keeps a direction the field names', async () => {
    const fetch = createFakeFetch(() => ({ body: '[]' }));

    await query(fetch).fields('id').sort('id').limit(500).offset(500).request('/platforms');
    await query(fetch).fields('id').sort('name desc').request('/genres');

    expect(fetch.requests.map(({ body }) => body)).toEqual([
      'fields id;sort id asc;limit 500;offset 500;',
      'fields id;sort name desc;',
    ]);
  });

  it('POSTs the query to the endpoint with the client id and the access token', async () => {
    const fetch = createFakeFetch(() => ({ body: '[{"id":1}]' }));

    const response = await query(fetch).fields('id').request<{ id: number }>('/games');

    expect(response.data).toEqual([{ id: 1 }]);
    expect(fetch.requests[0].method).toBe('POST');
    expect(fetch.requests[0].url.href).toBe('https://api.igdb.com/v4/games');
    expect(fetch.requests[0].headers).toEqual({
      'client-id': 'client-1',
      authorization: 'Bearer t',
      accept: 'application/json',
    });
  });

  // A proxy in front of IGDB can answer with an HTML page. It becomes an
  // error naming the status, never a JSON parse failure (#1082).
  it('fails with the status when IGDB answers with an error page', async () => {
    const fetch = createFakeFetch(() => ({
      status: 502,
      statusText: 'Bad Gateway',
      body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      headers: { 'content-type': 'text/html' },
    }));

    const failure = await query(fetch)
      .fields('id')
      .request('/games')
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(IgdbHttpError);
    expect(failure).toMatchObject({ status: 502, endpoint: '/games', message: 'IGDB answered 502 for /games' });
  });

  it('stops when its signal aborts', async () => {
    const controller = new AbortController();
    const pending = query(createFakeFetch(() => neverReply()))
      .fields('id')
      .request('/games', controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
