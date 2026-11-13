import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import {
  createFakeFetch,
  neverReply,
  runDataGatewayDriverContract,
} from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { join } from 'node:path';
import { BoardGameGeekDriver } from './boardgamegeek.driver';
import { bggFixtureFetch } from './testing/bgg-fixture-fetch';

const FIXTURES = join(__dirname, '..', 'testing', 'fixtures');

const silent: DriverLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Every wait the driver makes, cut to 1 ms, so a retry or a deadline can't slow the suite. */
const QUICK = { rateLimitRetryMs: 1, acceptedRetryMs: 1, acceptedRetries: 1, searchThingsDeadlineMs: 1 };

// The contract every DataGatewayDriver keeps, over recorded BGG answers (#1082).
runDataGatewayDriverContract('BoardGameGeekDriver', () => ({
  driver: new BoardGameGeekDriver({
    fetch: bggFixtureFetch(FIXTURES),
    apiKey: 'contract-key',
    version: '0.0.0-contract',
    logger: silent,
    timing: QUICK,
  }),
  capabilities: [
    proto.Capability.CAPABILITY_SEARCH,
    proto.Capability.CAPABILITY_FETCH,
    proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
    proto.Capability.CAPABILITY_LIST_LANGUAGES,
    proto.Capability.CAPABILITY_LIST_PLATFORMS,
    proto.Capability.CAPABILITY_LIST_CATEGORIES,
    proto.Capability.CAPABILITY_LIST_MECHANICS,
  ],
  filterableAxes: [
    proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
    proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
  ],
  upstream: proto.Upstream.UPSTREAM_BOARDGAMEGEEK,
  knownExternalId: '126163',
  unknownExternalId: '999999999',
  searchQuery: "Tzolk'in",
}));

// When nothing listens any more, such as a search the api gave up on, the
// driver's call to BGG stops, so a hung upstream holds nothing open (#1082).
describe('BoardGameGeekDriver when it is unsubscribed from', () => {
  const hung = () => {
    const fetch = createFakeFetch(() => neverReply());
    const driver = new BoardGameGeekDriver({ fetch, apiKey: 'key', version: '0.0.0', logger: silent });

    return { fetch, driver };
  };

  /** Lets the driver make the request it is about to make. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('aborts the fetch of a game', async () => {
    const { fetch, driver } = hung();

    const subscription = driver.fetchGame({ externalId: '1', correlationId: 'x' }).subscribe();
    await settle();
    subscription.unsubscribe();

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].signal?.aborted).toBe(true);
  });

  it('aborts a search', async () => {
    const { fetch, driver } = hung();

    const subscription = driver.searchGames({ query: 'Catan', correlationId: 'x' }).subscribe();
    await settle();
    subscription.unsubscribe();

    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0].signal?.aborted).toBe(true);
  });
});
