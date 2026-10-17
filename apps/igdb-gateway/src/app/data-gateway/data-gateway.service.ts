import type { GatewayServiceHost } from '@bge/gateway-host';
import { BGE_VERSION } from '@bge/version';
import * as proto from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { Observable, from, merge, of } from 'rxjs';
import { catchError, endWith, filter, map, mergeMap, shareReplay, tap } from 'rxjs/operators';
import { fetchExpansionsRequest, fetchGameRequest, searchGamesRequest } from '../igdb-requests/game.requests';
import { IGDBService } from '../igdb/igdb.service';
import {
  IGDB_CONTENT_TYPES,
  IGDB_PLATFORM_TYPES,
  toGameData,
  toGameSearchData,
  toSearchNarrowing,
} from '../mappers/game.mapper';
import { toGatewayLanguageEntries } from '../mappers/language.mapper';
import { IgdbGame } from '../types';

@Injectable()
export class DataGatewayService implements GatewayServiceHost {
  private readonly logger = new Logger(DataGatewayService.name);

  constructor(private readonly igdbService: IGDBService) {}

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'IgdbGateway',
      gatewayVersion: BGE_VERSION,
    };
  }

  describe(request: proto.DescribeRequest): proto.DescribeResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
      ],

      coverage: { platformTypes: [...IGDB_PLATFORM_TYPES], contentTypes: [...IGDB_CONTENT_TYPES] },

      /** Search narrows by both, through IGDB's game types and platform types (see toSearchNarrowing). */
      filterableAxes: [proto.CoverageAxis.COVERAGE_AXIS_PLATFORM_TYPE, proto.CoverageAxis.COVERAGE_AXIS_CONTENT_TYPE],
      languageCodeFormats: {
        acceptedRequestFormats: [
          proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
          proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_ISO_639_1,
        ],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
        passthroughSearchLanguage: false,
      },

      /** IGDB's summaries, sent as descriptions too, are plain text. */
      contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
    };
  }

  listLanguages(request: proto.ListLanguagesRequest): proto.ListLanguagesResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      languages: toGatewayLanguageEntries(),
    };
  }

  healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    this.logger.log(`Health check request from service: ${request.service}`);

    return {
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    };
  }

  /**
   * Searches IGDB for the request's query, narrowed by its filter. A filter
   * nothing IGDB has can match ends the search at once, without asking IGDB.
   */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const narrowing = toSearchNarrowing(request.filter);

    if (!narrowing) {
      return of({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      } satisfies proto.GatewaySearchResult);
    }

    return this.igdbService
      .call(searchGamesRequest(request.query, request.limit ?? 20, request.offset ?? 0, request.locale, narrowing))
      .pipe(
        tap((games) => this.logger.log(`searchGames found ${games.length} results for query '${request.query}'`)),

        mergeMap((games) => games),
        map((game) => ({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: toGameSearchData(game),
        })),

        endWith<proto.GatewaySearchResult>({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
        }),

        catchError((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`searchGames failed for query '${request.query}': ${message}`);

          return [
            {
              correlationId: request.correlationId,
              status: proto.ResultStatus.RESULT_STATUS_ERROR,
              message,
            } satisfies proto.GatewaySearchResult,
          ];
        }),
      );
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    const gameRequest$ = this.igdbService.call(fetchGameRequest(request.externalId, request.locale)).pipe(
      tap((games) => this.logger.log(`fetchGame found ${games.length} results for externalId '${request.externalId}'`)),
      shareReplay(1),
    );

    const noGames$ = gameRequest$.pipe(
      filter((games) => games.length === 0),
      map<IgdbGame[], proto.FetchGameResponse>(() => ({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_ERROR,
        message: `No game found for externalId '${request.externalId}'`,
      })),
    );

    const game$ = gameRequest$.pipe(
      filter((games) => games.length > 0),
      map((games) => games[0]),
      map((game) => {
        const gameData = toGameData(game);
        this.logger.debug(
          `fetchGame mapped IGDB game to GameData: ${gameData.title} (externalId: ${gameData.externalId})`,
        );

        return {
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: gameData,
        } satisfies proto.FetchGameResponse;
      }),
    );

    return merge(noGames$, game$).pipe(
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`fetchGame failed for externalId '${request.externalId}': ${message}`);

        return of({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_ERROR,
          message,
        } satisfies proto.FetchGameResponse);
      }),
    );
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    return this.igdbService.call(fetchExpansionsRequest(request.baseExternalId, request.locale)).pipe(
      mergeMap((games) => from(games)),
      map((game) => ({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_RESULT,
        game: toGameSearchData(game),
      })),

      endWith<proto.GatewaySearchResult>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`fetchExpansions failed for baseExternalId '${request.baseExternalId}': ${message}`);

        return [
          {
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_ERROR,
            message,
          } satisfies proto.GatewaySearchResult,
        ];
      }),
    );
  }
}
