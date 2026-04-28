import * as proto from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { EMPTY, Observable, defer, from, of } from 'rxjs';
import { catchError, endWith, map, mergeMap, tap } from 'rxjs/operators';
import {
  chunk,
  fetchThingRequest,
  fetchThingsRequest,
  parseExternalId,
  searchGamesRequest,
} from '../bgg-requests/game.requests';
import { BggService } from '../bgg/bgg.service';
import { BggThingType, MAX_THINGS_PER_BATCH } from '../constants';
import {
  getOutboundExpansionIds,
  searchItemToGameSearchData,
  thingToGameData,
  thingToGameSearchData,
} from '../mappers/game.mapper';
import type { BggThing } from '../types';

const FETCH_GAME_TYPES = [BggThingType.BoardGame, BggThingType.BoardGameExpansion] as const;
const EXPANSION_BATCH_TYPES = [BggThingType.BoardGameExpansion] as const;

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  constructor(private readonly bggService: BggService) {}

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request.correlationId ?? crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'BoardGameGeekGateway',
      gatewayVersion: '1.0.0',
      supportedServices: ['GatewayService'],
    } satisfies proto.GatewayPingResponse;
  }

  healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    this.logger.log(`Health check request from service: ${request.service}`);

    return {
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    } satisfies proto.HealthCheckResponse;
  }

  /**
   * Streams BGG search results as proto frames. Each result becomes a
   * RESULT frame; the stream always terminates with SOURCE_DONE on
   * success or a single ERROR frame on failure.
   *
   * Search results are intentionally lean — `thumbnailUrl`, ratings,
   * and player counts are not populated until a follow-up FetchGame is
   * issued.
   */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const limit = request.limit ?? undefined;
    const offset = request.offset ?? undefined;

    return this.bggService.call(searchGamesRequest(request.query, limit, offset)).pipe(
      tap((items) => this.logger.log(`searchGames found ${items.length} results for query '${request.query}'`)),

      mergeMap((items) => items),
      map(
        (item) =>
          ({
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_RESULT,
            game: searchItemToGameSearchData(item),
          } satisfies proto.GatewaySearchResult),
      ),

      endWith<proto.GatewaySearchResult>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`searchGames failed for query '${request.query}': ${message}`);

        return of({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_ERROR,
          message,
        } satisfies proto.GatewaySearchResult);
      }),
    );
  }

  /**
   * Fetches full GameData for a single BGG thing. Returns:
   *  - RESULT with populated `game` when found.
   *  - ERROR when the thing is not found, the externalId is malformed,
   *    or the underlying call fails (after its 429 retry is exhausted).
   *
   * The `defer` wrapper ensures a synchronous `parseExternalId` throw
   * surfaces through the catchError below as an ERROR frame rather than
   * an unhandled exception.
   */
  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    return defer(() => {
      const externalId = parseExternalId(request.externalId);

      return this.bggService.call(fetchThingRequest(externalId, { stats: 1, types: FETCH_GAME_TYPES }));
    }).pipe(
      tap((thing) =>
        this.logger.log(
          `fetchGame ${thing ? 'resolved' : 'returned no result for'} externalId '${request.externalId}'`,
        ),
      ),

      map<BggThing | undefined, proto.FetchGameResponse>((thing) => {
        if (!thing) {
          return {
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_ERROR,
            message: `No game found for externalId '${request.externalId}'`,
          };
        }

        const gameData = thingToGameData(thing);
        this.logger.debug(
          `fetchGame mapped BGG thing to GameData: ${gameData.title} (externalId: ${gameData.externalId})`,
        );

        return {
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: gameData,
        };
      }),

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

  /**
   * Streams the expansions of a base game as RESULT frames followed by
   * SOURCE_DONE.
   *
   * Composition shape:
   *   1. One `bggService.call` for the base thing — its own retry
   *      boundary.
   *   2. Outbound expansion ids are split into batches of size
   *      MAX_THINGS_PER_BATCH.
   *   3. Each batch flows through its own `bggService.call` — also its
   *      own retry boundary, so a 429 on batch 3 of 5 retries only
   *      batch 3 rather than re-running the entire fetch.
   *
   * If the base thing is missing or has no outbound expansion links,
   * only SOURCE_DONE is emitted (no error). If any single batch fails
   * after its retry is exhausted, the whole stream fails with an ERROR
   * frame — partial-success is not modeled at this layer.
   */
  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    return defer(() => {
      const baseId = parseExternalId(request.baseExternalId);

      return this.bggService
        .call(fetchThingRequest(baseId, { types: FETCH_GAME_TYPES }))
        .pipe(mergeMap((base) => this.streamExpansionsFromBase(base, request.baseExternalId)));
    }).pipe(
      map(
        (thing) =>
          ({
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_RESULT,
            game: thingToGameSearchData(thing),
          } satisfies proto.GatewaySearchResult),
      ),

      endWith<proto.GatewaySearchResult>({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`fetchExpansions failed for baseExternalId '${request.baseExternalId}': ${message}`);

        return of({
          correlationId: request.correlationId,
          status: proto.ResultStatus.RESULT_STATUS_ERROR,
          message,
        } satisfies proto.GatewaySearchResult);
      }),
    );
  }

  /**
   * Given the base thing, streams each outbound expansion thing one at
   * a time. Expansion ids are batched at MAX_THINGS_PER_BATCH and each
   * batch goes through its own `BggService.call` so retries are scoped
   * per-batch.
   *
   * Returns EMPTY (which becomes just a SOURCE_DONE upstream) when:
   *  - the base thing is undefined (id not in BGG),
   *  - the base thing has no outbound expansion links.
   */
  private streamExpansionsFromBase(base: BggThing | undefined, baseExternalIdForLogging: string): Observable<BggThing> {
    if (!base) {
      this.logger.log(`fetchExpansions found no base game for baseExternalId '${baseExternalIdForLogging}'`);
      return EMPTY;
    }

    const expansionIds = getOutboundExpansionIds(base);
    this.logger.log(
      `fetchExpansions found ${expansionIds.length} expansion ids for baseExternalId '${baseExternalIdForLogging}'`,
    );

    if (expansionIds.length === 0) {
      return EMPTY;
    }

    const batches = chunk(expansionIds, MAX_THINGS_PER_BATCH);

    // mergeMap fans the batches out concurrently. Each batch is a
    // separate bggService.call() — independent retry boundary.
    return from(batches).pipe(
      mergeMap((batch) => this.bggService.call(fetchThingsRequest(batch, { types: EXPANSION_BATCH_TYPES }))),
      mergeMap((things) => from(things)),
    );
  }
}
