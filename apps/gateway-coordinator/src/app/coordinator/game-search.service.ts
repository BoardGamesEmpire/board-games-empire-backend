import { DatabaseService } from '@bge/database';
import * as proto from '@board-games-empire/proto-gateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { defer, EMPTY, from, merge, Observable, of } from 'rxjs';
import { catchError, concatMap, endWith, filter, map, mergeMap, shareReplay, tap, throwIfEmpty } from 'rxjs/operators';
import { GatewayRegistryService } from '../gateway-registry/gateway-registry.service';

@Injectable()
export class GameSearchService {
  private readonly logger = new Logger(GameSearchService.name);
  private readonly searchCachePrefix = 'bge:search';
  /** TTL for cached search results per (gatewayId, query, limit, offset) — 5 minutes */
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

    const targetIds = request.gatewayIds.length > 0 ? request.gatewayIds : this.registry.connectedGatewayIds();
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
    return defer(() => of(this.registry.getServiceClient(request.gatewayId))).pipe(
      tap(() =>
        this.logger.debug(`Fetching game from gateway ${request.gatewayId} with externalId ${request.externalId}`),
      ),
      concatMap((client) => client.fetchGame({ correlationId: request.correlationId, externalId: request.externalId })),
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
        where: { gameId: request.gameId, gatewayId: { not: null } },
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
      filter(
        (source) => Boolean(source.gatewayId && source.externalId) && this.registry.isConnected(source.gatewayId!),
      ),
      mergeMap((source) =>
        this.fetchExpansionsFromGateway(source.gatewayId!, source.externalId!, request.correlationId).pipe(
          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `FetchExpansions failed for gateway ${source.gatewayId} and game ${source.externalId}: ${message}`,
            );

            return this.errorGameSearchResult(source.gatewayId!, request.correlationId, message);
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
    const cache$ = from(this.cache.get<proto.GameSearchData[]>(cacheKey)).pipe(shareReplay(1));

    const cacheHit$ = cache$.pipe(
      filter((cached) => cached !== undefined),
      tap(() => this.logger.debug(`Cache hit for gateway ${gatewayId} and query '${request.query}'`)),
      mergeMap((cached) => this.emitCachedResults(gatewayId, request.correlationId, cached!)),
    );

    const cacheMiss$ = cache$.pipe(
      filter((cached) => cached === undefined),
      tap(() => this.logger.debug(`Cache miss for gateway ${gatewayId} and query '${request.query}'`)),
      mergeMap(() => this.fetchFromGateway(gatewayId, request, cacheKey)),
    );

    return merge(cacheHit$, cacheMiss$).pipe(
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
    let client;
    try {
      client = this.registry.getServiceClient(gatewayId);
    } catch {
      return this.errorGameSearchResult(
        gatewayId,
        request.correlationId,
        `Gateway ${gatewayId} is not connected`,
        proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
      );
    }

    const stream$ = client.searchGames({
      correlationId: request.correlationId,
      query: request.query,
      limit: request.limit,
      offset: request.offset,
    });

    const accumulated: proto.GameSearchData[] = [];
    return stream$.pipe(
      mergeMap((result: proto.GatewaySearchResult) => this.mapGatewayResult(gatewayId, result, accumulated, cacheKey)),
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`gRPC stream error from gateway ${gatewayId}: ${message}`);

        return this.errorGameSearchResult(gatewayId, request.correlationId, message);
      }),
    );
  }

  private mapGatewayResult(
    gatewayId: string,
    result: proto.GatewaySearchResult,
    accumulated: proto.GameSearchData[],
    cacheKey: string,
  ): Observable<proto.SearchGameResult> {
    const base = { correlationId: result.correlationId, gatewayId };

    switch (result.status) {
      case proto.ResultStatus.RESULT_STATUS_RESULT: {
        if (!result.game) return EMPTY;

        accumulated.push(result.game);

        // Async dedup check
        return from(this.resolveDedup(gatewayId, result.game.externalId)).pipe(
          mergeMap(({ inSystem, gameId }) =>
            of<proto.SearchGameResult>({
              ...base,
              status: proto.ResultStatus.RESULT_STATUS_RESULT,
              game: result.game,
              inSystem,
              gameId,
            }),
          ),
        );
      }

      case proto.ResultStatus.RESULT_STATUS_SOURCE_DONE: {
        // Persist accumulated results to cache once the gateway signals completion
        void this.cache.set(cacheKey, accumulated, this.searchCacheTTL);
        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
        });
      }

      case proto.ResultStatus.RESULT_STATUS_RATE_LIMITED: {
        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_RATE_LIMITED,
          message: result.message,
          retryAfter: result.retryAfter,
        });
      }

      case proto.ResultStatus.RESULT_STATUS_UNAVAILABLE: {
        return of<proto.SearchGameResult>({
          ...base,
          status: proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        });
      }
      case proto.ResultStatus.RESULT_STATUS_ERROR: {
        return this.errorGameSearchResult(gatewayId, result.correlationId, result.message ?? 'Unknown error');
      }

      default: {
        return EMPTY;
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
      mergeMap((game: proto.GameSearchData) =>
        from(this.resolveDedup(gatewayId, game.externalId)).pipe(
          mergeMap(({ inSystem, gameId }) =>
            of<proto.SearchGameResult>({
              correlationId,
              gatewayId,
              status: proto.ResultStatus.RESULT_STATUS_RESULT,
              game,
              inSystem,
              gameId,
            }),
          ),
        ),
      ),
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
  ): Observable<proto.SearchGameResult> {
    let client;
    try {
      client = this.registry.getServiceClient(gatewayId);
    } catch {
      return this.errorGameSearchResult(
        gatewayId,
        correlationId,
        `Gateway ${gatewayId} is not connected`,
        proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
      );
    }

    return client.fetchExpansions({ correlationId, baseExternalId }).pipe(
      mergeMap((result: proto.GatewaySearchResult) => {
        if (result.status !== proto.ResultStatus.RESULT_STATUS_RESULT || !result.game) {
          return of<proto.SearchGameResult>({ correlationId, gatewayId, status: result.status });
        }

        return from(this.resolveDedup(gatewayId, result.game.externalId)).pipe(
          mergeMap(({ inSystem, gameId }) =>
            of<proto.SearchGameResult>({
              correlationId,
              gatewayId,
              status: proto.ResultStatus.RESULT_STATUS_RESULT,
              game: result.game,
              inSystem,
              gameId,
            }),
          ),
        );
      }),
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        return this.errorGameSearchResult(gatewayId, correlationId, message);
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

  private async resolveDedup(
    gatewayId: string,
    externalId: string,
  ): Promise<{ inSystem: boolean; gameId: string | undefined }> {
    const source = await this.db.gameSource.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId } },
      select: { gameId: true },
    });

    return {
      inSystem: source !== null,
      gameId: source?.gameId ?? undefined,
    };
  }

  private buildSearchCacheKey(gatewayId: string, request: proto.SearchGamesRequest): string {
    return `${this.searchCachePrefix}:${gatewayId}:${request.query}:${request.limit ?? ''}:${request.offset ?? ''}`;
  }
}
