import { GatewayServiceHost } from '@bge/gateway-host';
import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { from, of, type Observable } from 'rxjs';
import { STUB_CATEGORIES, STUB_GAMES, STUB_LANGUAGES, STUB_MECHANICS, STUB_PLATFORMS } from '../fixtures/catalog';

/**
 * Whether a publish year falls in a range, both bounds inclusive. A range
 * with no bound narrows nothing, and a game with no year matches only when
 * the range includes unknown ones (#719).
 */
function inYearRange(range: proto.IntRange | undefined, year: number | undefined): boolean {
  const min = range?.min ?? undefined;
  const max = range?.max ?? undefined;

  if (min === undefined && max === undefined) {
    return true;
  }

  if (year === undefined) {
    return range?.includeUnknown === true;
  }

  return (min === undefined || year >= min) && (max === undefined || year <= max);
}

/**
 * Whether a game supports every player count in a range (#869). A bound alone
 * is one count: a minimum of 5 means "supports 5", not "5 or more". A range
 * with no bound narrows nothing, and a game missing either of its counts
 * matches only when the range includes unknown ones.
 */
function supportsPlayerCount(
  range: proto.IntRange | undefined,
  minPlayers: number | undefined,
  maxPlayers: number | undefined,
): boolean {
  const min = range?.min ?? undefined;
  const max = range?.max ?? undefined;

  if (min === undefined && max === undefined) {
    return true;
  }

  if (minPlayers === undefined || maxPlayers === undefined) {
    return range?.includeUnknown === true;
  }

  const lo = min ?? max;
  const hi = max ?? min;

  return (lo === undefined || minPlayers <= lo) && (hi === undefined || hi <= maxPlayers);
}

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
    minPlaytime: game.minPlaytime,
    maxPlaytime: game.maxPlaytime,
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
   * tagged in BCP 47. Its search narrows by content type, publish year and
   * player count, so a DataGateway the server sends a filter to runs in the
   * e2e suites. It doesn't declare play time, though its results carry play
   * times, so they also cover a DataGateway a play-time search skips (#869).
   */
  describe(request: proto.DescribeRequest): proto.DescribeResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
        proto.Capability.CAPABILITY_LIST_PLATFORMS,
        proto.Capability.CAPABILITY_LIST_CATEGORIES,
        proto.Capability.CAPABILITY_LIST_MECHANICS,
      ],
      coverage: {
        platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
        contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_EXPANSION],
      },
      filterableAxes: [
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLAYER_COUNT,
      ],
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

  /** Serves every list, so each list job runs against it in the e2e suites (#718). */
  override listPlatforms(request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    return of({ correlationId: request.correlationId ?? crypto.randomUUID(), platforms: STUB_PLATFORMS });
  }

  override listCategories(request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    return of({ correlationId: request.correlationId ?? crypto.randomUUID(), categories: STUB_CATEGORIES });
  }

  override listMechanics(request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    return of({ correlationId: request.correlationId ?? crypto.randomUUID(), mechanics: STUB_MECHANICS });
  }

  /**
   * Each game whose title contains the query, ignoring case, whose content
   * type the filter names, if it names any, and whose publish year and player
   * counts fit the filter's ranges, if it gives them; paged by `offset` and
   * `limit`. It ignores a play-time range: it doesn't declare play time, so
   * the e2e suites cover a DataGateway a play-time search skips. A search that
   * keeps unknown play times still asks it, and the server checks the play
   * times its results carry (#869).
   */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const query = request.query.trim().toLowerCase();
    const offset = request.offset ?? 0;
    const contentTypes = request.filter?.contentTypes ?? [];
    const matches = STUB_GAMES.filter(
      (game) =>
        game.title.toLowerCase().includes(query) &&
        (contentTypes.length === 0 || contentTypes.includes(game.contentType)) &&
        inYearRange(request.filter?.publishYear, game.yearPublished) &&
        supportsPlayerCount(request.filter?.playerCount, game.minPlayers, game.maxPlayers),
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
