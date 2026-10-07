import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';

const NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/**
 * The bundle this suite boots has no web client beside it, so it stands for
 * every deployment without one: the api answers a browser exactly as it did
 * before it could serve the client (#598). What the client does when it is
 * present is covered by `@bge/web-client`'s own spec, against a build laid
 * out like Flutter's.
 */
describe('an api with no web client bundled', () => {
  const baseUrl = requireBaseUrl(process.env);

  it.each(['/', '/home', '/main.dart.js'])(
    'answers a page navigation to %s with the 404 it always gave',
    async (path) => {
      const response = await request(baseUrl).get(path).set('Accept', NAVIGATION);

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['cache-control']).toBeUndefined();
    },
  );
});
