import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import {
  createFakeFetch,
  neverReply,
  runDataGatewayDriverContract,
} from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { join } from 'node:path';
import { IgdbDriver } from './igdb.driver';
import { igdbFixtureFetch } from './testing/igdb-fixture-fetch';

const FIXTURES = join(__dirname, '..', 'testing', 'fixtures');
const TOKEN = JSON.stringify({ access_token: 'token', expires_in: 3600, token_type: 'bearer' });

const silent: DriverLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// The contract every DataGatewayDriver keeps, over recorded IGDB answers (#1082).
runDataGatewayDriverContract('IgdbDriver', async () => {
  const driver = new IgdbDriver({
    fetch: igdbFixtureFetch(FIXTURES),
    clientId: 'contract-client',
    clientSecret: 'contract-secret',
    version: '0.0.0-contract',
    logger: silent,
    timing: { rateLimitRetryMs: 1 },
  });
  await driver.start();

  return {
    driver,
    // IGDB has no mechanics (#718).
    capabilities: [
      proto.Capability.CAPABILITY_SEARCH,
      proto.Capability.CAPABILITY_FETCH,
      proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
      proto.Capability.CAPABILITY_LIST_LANGUAGES,
      proto.Capability.CAPABILITY_LIST_PLATFORMS,
      proto.Capability.CAPABILITY_LIST_CATEGORIES,
    ],
    filterableAxes: [
      proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLATFORM_TYPE,
      proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
      proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
    ],
    upstream: proto.Upstream.UPSTREAM_IGDB,
    knownExternalId: '14593',
    unknownExternalId: '999999999',
    searchQuery: 'Hollow Knight',
  };
});

describe('IgdbDriver', () => {
  /** A driver whose token comes at once and whose IGDB never answers. */
  const hung = async () => {
    const fetch = createFakeFetch(({ url }) => (url.host === 'api.igdb.com' ? neverReply() : { body: TOKEN }));
    const driver = new IgdbDriver({
      fetch,
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://tokens.example.test/oauth2/token',
      version: '0.0.0',
      logger: silent,
    });
    await driver.start();

    return { fetch, driver };
  };

  /** Lets the driver make the request it is about to make. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  // When nothing listens any more, the driver's call to IGDB stops, so a hung
  // upstream holds nothing open (#1082).
  describe('when it is unsubscribed from', () => {
    it('aborts the fetch of a game', async () => {
      const { fetch, driver } = await hung();

      const subscription = driver.fetchGame({ externalId: '1', correlationId: 'x' }).subscribe();
      await settle();
      subscription.unsubscribe();

      const asked = fetch.requests.filter(({ url }) => url.host === 'api.igdb.com');
      expect(asked).toHaveLength(1);
      expect(asked[0].signal?.aborted).toBe(true);
    });

    it('aborts a search', async () => {
      const { fetch, driver } = await hung();

      const subscription = driver.searchGames({ query: 'Hades', correlationId: 'x' }).subscribe();
      await settle();
      subscription.unsubscribe();

      const asked = fetch.requests.filter(({ url }) => url.host === 'api.igdb.com');
      expect(asked).toHaveLength(1);
      expect(asked[0].signal?.aborted).toBe(true);
    });
  });

  // The IGDB remote DataGateway's app awaits start() as it boots, so a token
  // endpoint that refuses fails the boot with this message, as
  // igdb-gateway-e2e checks (#630).
  it('fails to start, naming the status, when the token endpoint refuses', async () => {
    const fetch = createFakeFetch(() => ({ status: 503, statusText: 'Service Unavailable' }));
    const driver = new IgdbDriver({
      fetch,
      clientId: 'id',
      clientSecret: 'secret',
      version: '0.0.0',
      logger: silent,
    });

    await expect(driver.start()).rejects.toThrow('Failed to obtain IGDB access token: 503 Service Unavailable');
  });
});
