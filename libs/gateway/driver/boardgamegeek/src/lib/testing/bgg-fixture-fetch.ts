import { createFakeFetch, readFixture, type FakeFetch } from '@boardgamesempire/gateway-driver-contract-testing';
import { bggFixtureKey } from './bgg-fixture-key';

/**
 * An UpstreamFetch that answers each BGG request with its recorded upstream
 * fixture, named by {@link bggFixtureKey}, from `fixturesDir`. A request with
 * no fixture rejects, naming the fixture it wanted (#1082).
 */
export function bggFixtureFetch(fixturesDir: string): FakeFetch {
  return createFakeFetch(({ url }) => ({ body: readFixture(fixturesDir, `${bggFixtureKey(url)}.xml`) }));
}
