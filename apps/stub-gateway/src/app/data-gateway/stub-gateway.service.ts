import { GatewayServiceHost } from '@bge/gateway-host';
import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { from, of, type Observable } from 'rxjs';
import { STUB_GAMES, STUB_LANGUAGES } from '../fixtures/catalog';

/** How a search result describes a game: the fields a real gateway fills there. */
function toSearchData(game: proto.GameData): proto.GameSearchData {
  return {
    externalId: game.externalId,
    title: game.title,
    contentType: game.contentType,
    yearPublished: game.yearPublished,
    averageRating: game.averageRating,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    baseGameExternalId: game.baseGameExternalId,
    summary: game.description,
    availablePlatforms: game.platforms,
    availableReleases: game.releases,
  };
}

/**
 * Answers every RPC from the fixtures in `../fixtures/catalog`, the way the
 * real gateways answer them: results stream one frame per game and end with
 * SOURCE_DONE, and a game it does not know is an ERROR frame, not a gRPC
 * error.
 */
@Injectable()
export class StubGatewayService extends GatewayServiceHost {
  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'StubGateway',
      gatewayVersion: BGE_VERSION,
    };
  }

  /**
   * Declares what its fixtures hold: tabletop base games and expansions,
   * tagged in BCP 47. Its search narrows by content type, so a DataGateway
   * the server sends a filter to runs in the e2e suites.
   */
  describe(request: proto.DescribeRequest): proto.DescribeResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
      ],
      coverage: {
        platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
        contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_EXPANSION],
      },
      filterableAxes: [proto.CoverageAxis.COVERAGE_AXIS_CONTENT_TYPE],
      languageCodeFormats: {
        acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
        passthroughSearchLanguage: false,
      },
      contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
    };
  }

  healthCheck(): proto.HealthCheckResponse {
    return { status: proto.HealthCheckResponse_ServingStatus.SERVING };
  }

  listLanguages(request: proto.ListLanguagesRequest): proto.ListLanguagesResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      languages: STUB_LANGUAGES,
    };
  }

  /**
   * Each game whose title contains the query, ignoring case, and whose
   * content type the filter names, if it names any; paged by `offset` and
   * `limit`.
   */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const query = request.query.trim().toLowerCase();
    const offset = request.offset ?? 0;
    const contentTypes = request.filter?.contentTypes ?? [];
    const matches = STUB_GAMES.filter(
      (game) =>
        game.title.toLowerCase().includes(query) &&
        (contentTypes.length === 0 || contentTypes.includes(game.contentType)),
    );
    const page = matches.slice(offset, request.limit === undefined ? undefined : offset + request.limit);

    return this.stream(request.correlationId, page);
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    const game = STUB_GAMES.find((candidate) => candidate.externalId === request.externalId);

    return of(
      game
        ? { correlationId: request.correlationId, status: proto.ResultStatus.RESULT_STATUS_RESULT, game }
        : {
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_ERROR,
            message: `No game found for externalId '${request.externalId}'`,
          },
    );
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    const expansions = STUB_GAMES.filter((game) => game.baseGameExternalId === request.baseExternalId);

    return this.stream(request.correlationId, expansions);
  }

  private stream(correlationId: string, games: readonly proto.GameData[]): Observable<proto.GatewaySearchResult> {
    return from<proto.GatewaySearchResult[]>([
      ...games.map((game) => ({
        correlationId,
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: toSearchData(game),
      })),
      { correlationId, status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
    ]);
  }
}
