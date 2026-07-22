import { DatabaseService } from '@bge/database';
import { GatewayRegistryService } from '@bge/gateway-registry';
import * as proto from '@boardgamesempire/proto-gateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { defer, EMPTY, from, Observable, of } from 'rxjs';
import { catchError, concatMap, endWith, filter, map, mergeMap, tap, throwIfEmpty } from 'rxjs/operators';

/**
 * Cap for concurrent per-game dedup lookups on the cache-replay path. Live
 * gateway streams serialize through concatMap; replay has the whole result
 * set up front, so it fans out — bounded so a hot query can't monopolize the
 * connection pool.
 */
const DEDUP_CONCURRENCY = 10;

/**
 * gatewayId placed on error frames not attributable to a single gateway —
 * the GameSource lookup itself failed, or the game has no sources at all.
 * Deliberately not a valid gateway id so consumers and logs never
 * mis-attribute an aggregate failure to a real source.
 */
const NO_GATEWAY_ATTRIBUTION = '__no_gateway__';

/**
 * Fan-out game search + fetch across gateway drivers. Extracted from the
 * coordinator app (#193) so any host — coordinator today, the API process in
 * Phase 1 — can serve search over the same registry. Distinct from the
 * API-side `GameSearchService` (`@bge/game-search`), which combines local-DB
 * search with this external fan-out (via the coordinator client today,
 * in-process in Phase 1).
 *
 * Deliberate fixes over the coordinator original (review findings, #193):
 *  - RESULT/SOURCE_DONE ordering: per-gateway frames flow through concatMap
 *    so the synchronous SOURCE_DONE frame can no longer overtake RESULT
 *    frames whose dedup lookups are still in flight.
 *  - fetchExpansions no longer pre-filters on isConnected — resolve()
 *    lazily connects, and genuine unavailability surfaces as an UNAVAILABLE
 *    frame instead of a silent skip.
 *  - Cache-replay dedup concurrency is bounded (DEDUP_CONCURRENCY).
 */
@Injectable()
export class GatewayGameSearchService {
  private readonly logger = new Logger(GatewayGameSearchService.name);
  private readonly searchCachePrefix = 'bge:search';

  /**
   * TTL for cached search results per (gatewayId, query, limit, offset) — 5 minutes
   */
  private readonly searchCacheTTL = 5 * 60 * 1000;

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: GatewayRegistryService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Fan-out search across the requested gateways (or all connected if none
   * specified). Streams SearchGameResult frames as they arrive, with
   * deduplication metadata resolved against GameSource for each RESULT frame.
   */
  searchGames(request: proto.SearchGamesRequest): Observable<proto.SearchGameResult> {
    this.logger.debug(
      `Received search request with query '${request.query}' for gateways [${request.gatewayIds?.join(', ')}]`,
    );

    // Filter blank/invalid ids: a targeted request searches only the valid
    // ids among those given (never resolves '' or a non-string leaked from a
    // hand-built request); an untargeted request (no gatewayIds) fans out to
    // all connected. Distinguishing on the raw array keeps ['bgg',''] a
    // targeted search of ['bgg'], and [''] an empty targeted search (→ EMPTY)
    // rather than silently widening to "all connected".
    const rawIds = request.gatewayIds ?? [];
    const targeted = rawIds.length > 0;
    const requestedIds = rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    const targetIds = targeted ? requestedIds : this.registry.connectedGatewayIds();
    if (targetIds.length === 0) {
      return EMPTY;
    }

    return from(targetIds).pipe(
      tap((id) => this.logger.debug(`Initiating search on gateway ${id} for query '${request.query}'`)),
      mergeMap((id) => this.searchGateway(id, request)),
    );
  }

  /**
   * Fetch full GameData for a single game from a specific gateway.
   * Used by the import worker — bypasses the search cache.
   */
  fetchGame(request: proto.CoordinatorFetchGameRequest): Observable<proto.CoordinatorFetchGameResponse> {
    return defer(() => from(this.registry.resolve(request.gatewayId))).pipe(
      tap(() =>
        this.logger.debug(`Fetching game from gateway ${request.gatewayId} with externalId ${request.externalId}`),
      ),
      concatMap((driver) =>
        driver.fetchGame({
          correlationId: request.correlationId,
          externalId: request.externalId,
          locale: request.locale,
        }),
      ),
      tap((response) => {
        // Guard the pretty-print: JSON.stringify of a multi-KB game payload
        // would otherwise run on every response even when debug is disabled.
        if (Logger.isLevelEnabled('debug')) {
          this.logger.debug(
            `Received fetchGame response from gateway ${request.gatewayId} with status ${
              response.status
            } : ${JSON.stringify(response.game, null, 2)}`,
          );
        }
      }),
      map((response: proto.FetchGameResponse) => ({
        ...response,
        gatewayId: request.gatewayId,
      })),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`FetchGame failed for gateway ${request.gatewayId}: ${message}`);

        return of({
          correlationId: request.correlationId,
          gatewayId: request.gatewayId,
          status: proto.ResultStatus.RESULT_STATUS_ERROR,
          message,
        });
      }),
    );
  }

  /**
   * Fetch expansions for a base game by resolving its linked gateways from
   * GameSource and calling FetchExpansions on each.
   */
  fetchExpansions(request: proto.CoordinatorFetchExpansionsRequest): Observable<proto.SearchGameResult> {
    const sources$ = from(
      this.db.gameSource.findMany({
        where: { gameId: request.gameId },
        select: { gatewayId: true, externalId: true },
      }),
    );

    return sources$.pipe(
      filter((sources) => sources.length > 0),
      throwIfEmpty(() => new Error(`No gateway sources found for gameId ${request.gameId}`)),
      tap((sources) =>
        this.logger.debug(
          `Found ${sources.length} gateways for gameId ${request.gameId}: ${sources
            .map((s) => s.gatewayId)
            .join(', ')}`,
        ),
      ),

      mergeMap((sources) => sources),
      // No isConnected pre-filter: resolve() lazily connects cold gateways,
      // and a genuinely unavailable one yields an UNAVAILABLE frame below —
      // never a silent skip that masquerades as "no expansions".
      filter((source) => Boolean(source.gatewayId && source.externalId)),
      mergeMap((source) =>
        this.fetchExpansionsFromGateway(
          source.gatewayId,
          source.externalId,
          request.correlationId,
          request.locale,
        ).pipe(
          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`FetchExpansions failed for gameId ${request.gameId}: ${message}`);

            return this.errorGameSearchResult(NO_GATEWAY_ATTRIBUTION, request.correlationId, message);
          }),
        ),
      ),

      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`FetchExpansions failed for gameId ${request.gameId}: ${message}`);

        return this.errorGameSearchResult(request.gameId, request.correlationId, message);
      }),
    );
  }

  private searchGateway(gatewayId: string, request: proto.SearchGamesRequest): Observable<proto.SearchGameResult> {
    const cacheKey = this.buildSearchCacheKey(gatewayId, request);

    return from(this.cache.get<proto.GameSearchData[]>(cacheKey)).pipe(
      catchError((err) => {
        this.logger.warn(
          `Search cache read failed for gateway ${gatewayId}; falling through to live fetch: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return of(undefined);
      }),
      mergeMap((cached) => {
        if (cached !== undefined) {
          this.logger.debug(`Cache hit for gateway ${gatewayId} and query '${request.query}'`);
          return this.emitCachedResults(gatewayId, request.correlationId, cached);
        }

        this.logger.debug(`Cache miss for gateway ${gatewayId} and query '${request.query}'`);
        return this.fetchFromGateway(gatewayId, request, cacheKey);
      }),
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Search failed for gateway ${gatewayId}: ${message}`);

        return this.errorGameSearchResult(gatewayId, request.correlationId, message);
      }),
    );
  }

  private fetchFromGateway(
    gatewayId: string,
    request: proto.SearchGamesRequest,
    cacheKey: string,
  ): Observable<proto.SearchGameResult> {
    return from(this.registry.resolve(gatewayId)).pipe(
      mergeMap((driver) => {
        const accumulated: proto.GameSearchData[] = [];

        return driver
          .searchGames({
            correlationId: request.correlationId,
            query: request.query,
            limit: request.limit,
            offset: request.offset,
            locale: request.locale,
          })
          .pipe(
            // concatMap, not mergeMap: RESULT frames resolve dedup against the
            // DB while SOURCE_DONE maps synchronously — merged, the completion
            // frame overtakes still-pending RESULTs and consumers finalize the
            // source early. Serializing preserves gateway emission order (and
            // caps dedup concurrency on the live path as a side effect).
            concatMap((result: proto.GatewaySearchResult) =>
              this.mapGatewayResult(gatewayId, result, accumulated, cacheKey),
            ),
            catchError((err) => {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.error(`gRPC stream error from gateway ${gatewayId}: ${message}`);

              return this.errorGameSearchResult(gatewayId, request.correlationId, message);
            }),
          );
      }),
      // Resolve/lazy-connect failure → the gateway is unavailable, distinct
      // from a mid-stream gRPC error (handled above as ERROR).
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Gateway ${gatewayId} unavailable: ${message}`);

        return this.errorGameSearchResult(
          gatewayId,
          request.correlationId,
          `Gateway ${gatewayId} is not connected`,
          proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        );
      }),
    );
  }

  private mapGatewayResult(
    gatewayId: string,
    result: proto.GatewaySearchResult,
    accumulated: proto.GameSearchData[],
    cacheKey: string,
  ): Observable<proto.SearchGameResult> {
    this.logger.debug(`Received search result from gateway ${gatewayId} with status ${result.status}`);
    const base = { correlationId: result.correlationId, gatewayId };

    switch (result.status) {
      case proto.ResultStatus.RESULT_STATUS_RESULT: {
        if (!result.game) {
          this.logger.warn(`Received RESULT status from gateway ${gatewayId} without game data`);

          return EMPTY;
        }

        this.logger.debug(`Accumulating game with externalId ${result.game.externalId} from gateway ${gatewayId}`);
        accumulated.push(result.game);

        // Async dedup check
        return this.toResultFrame(gatewayId, result.correlationId, result.game);
      }

      case proto.ResultStatus.RESULT_STATUS_SOURCE_DONE: {
        this.logger.debug(`Gateway ${gatewayId} has completed sending results`);

        // Persist accumulated results to cache once the gateway signals completion
        void this.cache
          .set(cacheKey, accumulated, this.searchCacheTTL)
          .catch((err) =>
            this.logger.warn(
              `Search cache write failed for gateway ${gatewayId}: ${err instanceof Error ? err.message : err}`,
            ),
          );
        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
        });
      }

      case proto.ResultStatus.RESULT_STATUS_RATE_LIMITED: {
        this.logger.warn(
          `Gateway ${gatewayId} is rate limited: ${result.message ?? 'No additional info'}, retry after ${
            result.retryAfter ?? 'unknown'
          } seconds`,
        );

        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_RATE_LIMITED,
          message: result.message,
          retryAfter: result.retryAfter,
        });
      }

      case proto.ResultStatus.RESULT_STATUS_UNAVAILABLE: {
        this.logger.warn(`Gateway ${gatewayId} is unavailable: ${result.message ?? 'No additional info'}`);

        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        });
      }
      case proto.ResultStatus.RESULT_STATUS_ERROR: {
        this.logger.error(`Received error status from gateway ${gatewayId}: ${result.message ?? 'Unknown error'}`);
        return this.errorGameSearchResult(gatewayId, result.correlationId, result.message ?? 'Unknown error');
      }

      default: {
        this.logger.warn(`Received unknown status ${result.status} from gateway ${gatewayId}`);
        return this.errorGameSearchResult(gatewayId, result.correlationId, `Unknown status ${result.status}`);
      }
    }
  }

  /**
   * Emit cached GameSearchData frames followed by SOURCE_DONE, running
   * dedup fresh for each (cache doesn't store inSystem — it changes over time).
   */
  private emitCachedResults(
    gatewayId: string,
    correlationId: string,
    cached: proto.GameSearchData[],
  ): Observable<proto.SearchGameResult> {
    const resultFrames$ = from(cached).pipe(
      // Bounded: an unbounded fan-out here issues one findUnique per cached
      // game simultaneously and can saturate the Prisma pool on hot queries.
      // endWith keeps SOURCE_DONE last regardless (appended on completion).
      mergeMap((game: proto.GameSearchData) => this.toResultFrame(gatewayId, correlationId, game), DEDUP_CONCURRENCY),
    );

    return resultFrames$.pipe(
      endWith({
        correlationId,
        gatewayId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),
      tap(() => this.logger.debug(`Emitted ${cached.length} cached results for gateway ${gatewayId}`)),
    );
  }

  private fetchExpansionsFromGateway(
    gatewayId: string,
    baseExternalId: string,
    correlationId: string,
    locale?: string,
  ): Observable<proto.SearchGameResult> {
    return from(this.registry.resolve(gatewayId)).pipe(
      mergeMap((driver) =>
        driver.fetchExpansions({ correlationId, baseExternalId, locale }).pipe(
          // Same ordering rationale as fetchFromGateway: async RESULT frames
          // must not be overtaken by synchronously-mapped status frames.
          concatMap((result: proto.GatewaySearchResult) => {
            if (result.status !== proto.ResultStatus.RESULT_STATUS_RESULT || !result.game) {
              return of<proto.SearchGameResult>({
                correlationId,
                gatewayId,
                status: result.status,
                message: result.message,
                retryAfter: result.retryAfter,
              });
            }
            return this.toResultFrame(gatewayId, correlationId, result.game);
          }),
          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            return this.errorGameSearchResult(gatewayId, correlationId, message);
          }),
        ),
      ),
      // Resolve/lazy-connect failure → gateway unavailable.
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Gateway ${gatewayId} unavailable: ${message}`);

        return this.errorGameSearchResult(
          gatewayId,
          correlationId,
          `Gateway ${gatewayId} is not connected`,
          proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        );
      }),
    );
  }

  /**
   * Wrapper to emit an error SearchGameResult in case of failures during fetch operations
   */
  private errorGameSearchResult(
    gatewayId: string,
    correlationId: string,
    message: string,
    status = proto.ResultStatus.RESULT_STATUS_ERROR,
  ): Observable<proto.SearchGameResult> {
    return of<proto.SearchGameResult>({
      correlationId,
      gatewayId,
      status,
      message,
    });
  }

  /**
   * Builds a RESULT_STATUS_RESULT frame for a single game, resolving its
   * inSystem/gameId dedup metadata fresh (the cache never stores it — it
   * changes over time). Shared by the live gateway stream, the cache-replay
   * path, and fetchExpansions so the frame shape lives in exactly one place.
   */
  private toResultFrame(
    gatewayId: string,
    correlationId: string,
    game: proto.GameSearchData,
  ): Observable<proto.SearchGameResult> {
    return from(this.resolveDedup(gatewayId, game.externalId)).pipe(
      map(
        ({ inSystem, gameId }): proto.SearchGameResult => ({
          correlationId,
          gatewayId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game,
          inSystem,
          gameId,
        }),
      ),
    );
  }

  private resolveDedup(
    gatewayId: string,
    externalId: string,
  ): Observable<{ inSystem: boolean; gameId: string | undefined }> {
    return from(
      this.db.gameSource.findUnique({
        where: { gatewayId_externalId: { gatewayId, externalId } },
        select: { gameId: true },
      }),
    ).pipe(
      tap((source) => {
        this.logger.debug(
          `Resolved dedup for gateway ${gatewayId} and externalId ${externalId}: inSystem=${source !== null}, gameId=${
            source?.gameId
          }`,
        );
      }),
      map((source) => ({
        inSystem: source !== null,
        gameId: source?.gameId,
      })),
    );
  }

  private buildSearchCacheKey(gatewayId: string, request: proto.SearchGamesRequest): string {
    return [
      this.searchCachePrefix,
      gatewayId,
      encodeURIComponent(request.query),
      encodeURIComponent(request.locale ?? ''),
      request.limit ?? '',
      request.offset ?? '',
    ].join(':');
  }
}
