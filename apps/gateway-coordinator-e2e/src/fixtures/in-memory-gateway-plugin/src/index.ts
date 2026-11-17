import type { DataGatewayDriverFactory } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import type { PluginContext, PluginFactory } from '@boardgamesempire/plugin-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import type { Observable } from 'rxjs';
import { defer, map, of } from 'rxjs';
import type { FixtureBuild } from '../../../support/fixture-build.js';

/**
 * The e2e suite's data-gateway plugin (#1083): the contract's in-memory
 * driver over one game, declaring Search, Fetch and FetchGames. The suite
 * bundles it with esbuild, places it under a plugins root as an install
 * would, and has the built coordinator load it.
 *
 * `__FIXTURE_BUILD__` is defined at bundle time (`placeFixturePlugin`), so
 * two bundles of this file can be two versions of the plugin.
 */
declare const __FIXTURE_BUILD__: FixtureBuild;

const build = __FIXTURE_BUILD__;

const game: proto.GameData = {
  externalId: build.game.externalId,
  title: build.game.title,
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  designers: [],
  artists: [],
  publishers: [],
  mechanics: [],
  categories: [],
  families: [],
  baseGameExternalIds: [],
  platforms: [],
  releases: [],
  themes: [],
  ageRatings: [],
  metadataKeys: [],
  metadataValues: [],
  dlc: [],
  crossReferences: [],
};

const searchResult: proto.GameSearchData = {
  externalId: build.game.externalId,
  title: build.game.title,
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  baseGameExternalIds: [],
  availablePlatforms: [],
  availableReleases: [],
  crossReferences: [],
};

class FixtureDriver extends InMemoryGatewayDriver {
  constructor(private readonly context: PluginContext) {
    super({
      gatewayName: context.slug,
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_GAMES,
      ],
      fetchGamesMaxIds: build.fetchGamesMaxIds,
      searchResults: [searchResult],
      games: [game],
    });
  }

  /** The build's version, where the in-memory driver reports a fixed one. */
  override ping(request: proto.GatewayPingRequest): Observable<proto.GatewayPingResponse> {
    return super.ping(request).pipe(map((pong) => ({ ...pong, gatewayVersion: build.version })));
  }

  /**
   * The probe's external ID answers with the actor this code runs as, read
   * when the answer is subscribed to, which is when a real driver would do
   * its work. Any other ID is the in-memory driver's to answer.
   */
  override fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    if (request.externalId !== build.actorProbeExternalId) {
      return super.fetchGame(request);
    }

    return defer(() =>
      of<proto.FetchGameResponse>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game,
        message: JSON.stringify(this.context.actor.current()),
      }),
    );
  }
}

const plugin: PluginFactory = (context) => {
  const driverFactory: DataGatewayDriverFactory = () => new FixtureDriver(context);

  return driverFactory;
};

export default plugin;
