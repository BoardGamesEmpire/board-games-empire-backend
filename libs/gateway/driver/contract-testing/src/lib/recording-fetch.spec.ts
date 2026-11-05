import { createFakeFetch } from './fake-fetch.js';
import { createRecordingFetch } from './recording-fetch.js';

/**
 * Recording an upstream's answers through the driver's own requests, so a
 * driver's upstream fixtures can be recorded again (#1082, #614).
 */
describe('createRecordingFetch', () => {
  it('asks through the fetch it wraps, and answers with what that answered', async () => {
    const upstream = createFakeFetch(() => ({ body: '<items/>', headers: { 'content-type': 'text/xml' } }));
    const signal = new AbortController().signal;

    const response = await createRecordingFetch(() => undefined, upstream)(
      'https://boardgamegeek.com/xmlapi2/thing?id=1',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer key' },
        signal,
      },
    );

    expect(upstream.requests[0]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer key' }, signal });
    expect(upstream.requests[0].url.href).toBe('https://boardgamegeek.com/xmlapi2/thing?id=1');
    expect([response.status, response.headers.get('content-type'), await response.text()]).toEqual([
      200,
      'text/xml',
      '<items/>',
    ]);
  });

  it('hands each successful answer to the recorder, with its request', async () => {
    const record = jest.fn();
    const fetch = createRecordingFetch(
      record,
      createFakeFetch(() => ({ body: '[{"id":1}]' })),
    );

    await fetch('https://api.igdb.com/v4/games', { method: 'POST', headers: {}, body: 'fields id;' });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ method: 'POST', body: 'fields id;' });
    expect(record.mock.calls[0][0].url.href).toBe('https://api.igdb.com/v4/games');
    expect(record.mock.calls[0][1]).toBe('[{"id":1}]');
  });

  // BGG answers 202 while it prepares an answer, and the driver asks again.
  it('records no answer that is not a success, but still hands it back', async () => {
    const record = jest.fn();
    const statuses = [202, 429, 502];
    const fetch = createRecordingFetch(
      record,
      createFakeFetch(() => ({ status: statuses.shift(), body: 'not yet' })),
    );

    const answered: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      answered.push(
        (await fetch('https://boardgamegeek.com/xmlapi2/thing?id=1', { method: 'GET', headers: {} })).status,
      );
    }

    expect(answered).toEqual([202, 429, 502]);
    expect(record).not.toHaveBeenCalled();
  });

  // A Response refuses a body, even an empty one, for these statuses, so the
  // answer handed back is built without one rather than throwing (#1082).
  it.each([204, 304])('hands back a %i answer with no body', async (status) => {
    const fetch = createRecordingFetch(
      () => undefined,
      createFakeFetch(() => ({ status })),
    );

    const response = await fetch('https://api.igdb.com/v4/games', { method: 'POST', headers: {} });

    expect([response.status, response.body]).toEqual([status, null]);
  });
});
