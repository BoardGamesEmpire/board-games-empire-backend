import { createFakeFetch, readFixture, type FakeFetch } from '@boardgamesempire/gateway-driver-contract-testing';
import { IGDB_BASE_URL } from '../client/igdb-query';
import { igdbFixtureKey } from './igdb-fixture-key';

/** What the recordings were made with, in place of a real token. */
const GOLDEN_TOKEN = JSON.stringify({ access_token: 'golden-token', expires_in: 3600, token_type: 'bearer' });

/**
 * An UpstreamFetch that answers each IGDB query with its recorded upstream
 * fixture, named by {@link igdbFixtureKey}, from `fixturesDir`, and any other
 * request, which is the token endpoint's, with a token. A query with no
 * fixture rejects, naming the fixture it wanted (#1082).
 */
export function igdbFixtureFetch(fixturesDir: string): FakeFetch {
  return createFakeFetch(({ url, body }) => {
    if (!url.href.startsWith(`${IGDB_BASE_URL}/`)) {
      return { body: GOLDEN_TOKEN };
    }

    const endpoint = url.href.slice(IGDB_BASE_URL.length);
    return { body: readFixture(fixturesDir, `${igdbFixtureKey(endpoint, body ?? '')}.json`) };
  });
}
