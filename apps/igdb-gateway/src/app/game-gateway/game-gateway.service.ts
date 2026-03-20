import * as proto from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { Observable, from } from 'rxjs';
import { catchError, endWith, map, mergeMap, tap } from 'rxjs/operators';
import { fetchExpansionsRequest, fetchGameRequest, searchGamesRequest } from '../igdb-requests/game.requests';
import { IGDBService } from '../igdb/igdb.service';
import { toGameData, toGameSearchData } from '../mappers/game.mapper';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  constructor(private readonly igdbService: IGDBService) {}

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'IgdbGateway',
      gatewayVersion: '1.0.0',
      supportedServices: ['GatewayService'],
    };
  }

  healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    this.logger.log(`Health check request from service: ${request.service}`);

    return {
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    };
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    return this.igdbService.call(searchGamesRequest(request.query, request.limit ?? 20, request.offset ?? 0)).pipe(
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
    return this.igdbService.call(fetchGameRequest(request.externalId)).pipe(
      map((games) => {
        this.logger.log(`fetchGame found ${games.length} results for externalId '${request.externalId}'`);

        if (games.length === 0) {
          return {
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_ERROR,
            message: `No game found for externalId ${request.externalId}`,
          } satisfies proto.FetchGameResponse;
        }

        return {
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: toGameData(games[0]),
        } satisfies proto.FetchGameResponse;
      }),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`fetchGame failed for externalId '${request.externalId}': ${message}`);

        return [
          {
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_ERROR,
            message,
          } satisfies proto.FetchGameResponse,
        ];
      }),
    );
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    return this.igdbService.call(fetchExpansionsRequest(request.baseExternalId)).pipe(
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
