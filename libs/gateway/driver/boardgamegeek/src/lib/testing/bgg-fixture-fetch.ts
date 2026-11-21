import type { FakeFetch } from '@boardgamesempire/gateway-driver-contract-testing';
import { createFakeFetch, readFixture } from '@boardgamesempire/gateway-driver-contract-testing';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bggFixtureKey } from './bgg-fixture-key';

/**
 * An UpstreamFetch that answers each BGG request with its recorded upstream
 * fixture, named by {@link bggFixtureKey}, from `fixturesDir`. A request with
 * no fixture rejects, naming the fixture it wanted (#1082). A fixture named
 * `<key>.404.html` answers 404 with its body, as BGG answers `/user` for a
 * name it doesn't know (#1226).
 */
export function bggFixtureFetch(fixturesDir: string): FakeFetch {
  return createFakeFetch(({ url }) => {
    const key = bggFixtureKey(url);

    if (existsSync(join(fixturesDir, `${key}.404.html`))) {
      return { status: 404, statusText: 'Not Found', body: readFixture(fixturesDir, `${key}.404.html`) };
    }

    return { body: readFixture(fixturesDir, `${key}.xml`) };
  });
}
