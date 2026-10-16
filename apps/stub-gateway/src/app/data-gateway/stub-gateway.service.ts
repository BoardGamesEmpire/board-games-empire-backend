import type { GatewayServiceHost } from '@bge/gateway-host';
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
export class StubGatewayService implements GatewayServiceHost {
  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'StubGateway',
      gatewayVersion: '1.0.0',
      supportedServices: ['GatewayService'],
      languagePreferences: {
        acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
        passthroughRawLocale: false,
      },
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

  /** Each game whose title contains the query, ignoring case, paged by `offset` and `limit`. */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const query = request.query.trim().toLowerCase();
    const offset = request.offset ?? 0;
    const matches = STUB_GAMES.filter((game) => game.title.toLowerCase().includes(query));
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
