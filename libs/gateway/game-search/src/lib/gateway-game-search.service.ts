import { convertToMarkdown } from '@bge/content-format';
import { type ContentFormat, DatabaseService, DataGatewayCapability, type SearchFilterAxis } from '@bge/database';
import {
  GatewayRegistryService,
  type GatewayResolution,
  GatewayRoutingRefusedError,
  type SearchResolution,
  type SearchRoute,
} from '@bge/gateway-registry';
import * as proto from '@boardgamesempire/proto-gateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { defer, EMPTY, from, Observable, of } from 'rxjs';
import { catchError, concatMap, endWith, map, mergeMap, tap } from 'rxjs/operators';
import { filterFor, matchesFilter, type ResultFilter, toResultFilter, unfilterableAxes } from './search-filter';

/**
 * Cap for concurrent per-game dedup lookups on the cache-replay path. Live
 * gateway streams serialize through concatMap; replay has the whole result
 * set up front, so it fans out — bounded so a hot query can't monopolize the
 * connection pool.
 */
const DEDUP_CONCURRENCY = 10;

/**
 * One live gateway stream's games, cached when the gateway sends SOURCE_DONE.
 * A status frame before that (rate limit, unavailability, error) marks the
 * set partial: replayed for the cache TTL, it would hide the failure behind a
 * short result list.
 */
interface SearchAccumulator {
  games: proto.GameSearchData[];
  partial: boolean;
}

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
 *  - fetchExpansions doesn't pre-filter on isConnected — resolve() lazily
 *    connects, and genuine unavailability surfaces as an UNAVAILABLE frame
 *    instead of a silent skip. It asks the one DataGateway it's named, by
 *    the base game's external ID there (#1067).
 *  - Cache-replay dedup concurrency is bounded (DEDUP_CONCURRENCY).
 */
@Injectable()
export class GatewayGameSearchService {
  private readonly logger = new Logger(GatewayGameSearchService.name);
  private readonly searchCachePrefix = 'bge:search';
  private readonly expansionsCachePrefix = 'bge:expansions';

  /**
   * TTL for cached search results per DataGateway and request sent to it, and
   * for a DataGateway's expansion list of a base game (#1067) — 5 minutes
   */
  private readonly searchCacheTTL = 5 * 60 * 1000;

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: GatewayRegistryService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Searches the requested DataGateways, or, when none is named, every one
   * this process has connected that may search and whose coverage overlaps
   * the request's filter. Streams SearchGameResult frames as they arrive,
   * with deduplication metadata resolved against GameSource for each RESULT
   * frame.
   *
   * A filtered search sends each DataGateway the filter on the axes its
   * search narrows by, and removes every result the filter excludes, however
   * the DataGateway narrowed (#713). A named DataGateway whose coverage
   * doesn't overlap the filter isn't asked, and answers SOURCE_DONE alone.
   * A publish year narrows the results but never skips a DataGateway, since
   * none declares which years it covers (#719). A player count or play time
   * that keeps no unknown values skips a DataGateway that doesn't declare it:
   * without that promise none of its results can be counted on to pass.
   * Unless its coverage misses first, that DataGateway answers UNFILTERABLE
   * alone (#869).
   */
  searchGames(request: proto.SearchGamesRequest): Observable<proto.SearchGameResult> {
    this.logger.debug(
      `Received search request with query '${request.query}' for gateways [${request.gatewayIds?.join(', ')}]`,
    );

    const resultFilter = toResultFilter(request.filter);

    // Filter blank/invalid ids: a targeted request searches only the valid
    // ids among those given (never resolves '' or a non-string leaked from a
    // hand-built request); an untargeted request (no gatewayIds) goes to every
    // connected DataGateway that may search. Distinguishing on the raw array
    // keeps ['bgg',''] a targeted search of ['bgg'], and [''] an empty
    // targeted search (→ EMPTY) rather than silently widening to "all".
    const rawIds = request.gatewayIds ?? [];
    const targeted = rawIds.length > 0;
    const requestedIds = rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0);

    // A named DataGateway that may not search is still asked for, so its
    // refusal comes back as an UNAVAILABLE frame that says why. One this
    // process hasn't connected yet isn't reached by an untargeted search (#722).
    const targetIds$ = targeted
      ? of(requestedIds)
      : defer(() => from(this.registry.routableGatewayIds(DataGatewayCapability.Search, resultFilter)));

    return targetIds$.pipe(
      mergeMap((ids) => from(ids)),
      tap((id) => this.logger.debug(`Initiating search on gateway ${id} for query '${request.query}'`)),
      mergeMap((id) => this.searchGateway(id, request, resultFilter)),
    );
  }

  /**
   * Fetch full GameData for a single game from a specific gateway.
   * Used by the import worker — bypasses the search cache.
   */
  fetchGame(request: proto.CoordinatorFetchGameRequest): Observable<proto.CoordinatorFetchGameResponse> {
    return defer(() => from(this.registry.resolve(request.gatewayId, DataGatewayCapability.Fetch))).pipe(
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
   * Asks one DataGateway for a base game's expansions, by the base game's
   * external ID there. A game on this server is asked for by the API, once
   * per DataGateway link, after it checks the actor may read the game: this
   * service has no actor to check that against (#1067).
   */
  fetchExpansions(request: proto.CoordinatorFetchExpansionsRequest): Observable<proto.SearchGameResult> {
    return this.fetchExpansionsFromGateway(
      request.gatewayId,
      request.baseExternalId,
      request.correlationId,
      request.locale,
    );
  }

  private searchGateway(
    gatewayId: string,
    request: proto.SearchGamesRequest,
    resultFilter: ResultFilter,
  ): Observable<proto.SearchGameResult> {
    return defer(() => from(this.registry.searchRoute(gatewayId, resultFilter))).pipe(
      // A route that can't be read leaves the search to the live path, as a
      // cache miss does. It reads the row again, and if that fails too it
      // answers UNAVAILABLE, keeping the failure's detail for the log.
      catchError((err) => {
        this.logger.warn(
          `Search route read failed for gateway ${gatewayId}; falling through to live fetch: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return of<SearchRoute>({ routable: false });
      }),
      mergeMap((route) => {
        // One that may not search now gets the live path, never its cache:
        // the gateway registry refuses it, saying why, or connects and
        // interviews one never interviewed, whose coverage it then reads.
        if (!route.routable) {
          return this.fetchFromGateway(gatewayId, request, resultFilter);
        }

        if (!route.covers) {
          return this.uncoveredSearch(gatewayId, request.correlationId);
        }

        // Checked before the cache read: one that can't apply a range the
        // search names isn't asked, nor answered from its cache (#869).
        const unfilterable = unfilterableAxes(resultFilter, route.filterableAxes);
        if (unfilterable.length > 0) {
          return this.unfilterableSearch(gatewayId, request.correlationId, unfilterable);
        }

        const cacheKey = this.buildSearchCacheKey(gatewayId, this.gatewayRequest(request, route.filterableAxes));

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
            if (cached === undefined) {
              this.logger.debug(`Cache miss for gateway ${gatewayId} and query '${request.query}'`);
              // Asked by the route already read, so its row isn't read again.
              return this.fetchFromGateway(gatewayId, request, resultFilter, async () => ({
                driver: await route.driver(),
                filterableAxes: route.filterableAxes,
                contentFormat: route.contentFormat,
              }));
            }

            this.logger.debug(`Cache hit for gateway ${gatewayId} and query '${request.query}'`);
            return this.emitCachedResults(gatewayId, request.correlationId, cached, resultFilter, route.contentFormat);
          }),
        );
      }),
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Search failed for gateway ${gatewayId}: ${message}`);

        return this.errorGameSearchResult(gatewayId, request.correlationId, message);
      }),
    );
  }

  /**
   * Asks the DataGateway live, by `resolution`: by default the gateway
   * registry's, which refuses one that may not search, saying why, and
   * interviews one never interviewed. A caller that has read its route
   * passes that route's driver instead.
   */
  private fetchFromGateway(
    gatewayId: string,
    request: proto.SearchGamesRequest,
    resultFilter: ResultFilter,
    resolution: () => Promise<SearchResolution | null> = () => this.registry.resolveSearch(gatewayId, resultFilter),
  ): Observable<proto.SearchGameResult> {
    return defer(resolution).pipe(
      mergeMap((resolved) => {
        if (!resolved) {
          return this.uncoveredSearch(gatewayId, request.correlationId);
        }

        // Checked here too for the live path: a named DataGateway this process
        // hasn't connected arrives without a route, and its search filters
        // are read only as it's resolved (#869).
        const unfilterable = unfilterableAxes(resultFilter, resolved.filterableAxes);
        if (unfilterable.length > 0) {
          return this.unfilterableSearch(gatewayId, request.correlationId, unfilterable);
        }

        const gatewayRequest = this.gatewayRequest(request, resolved.filterableAxes);
        const cacheKey = this.buildSearchCacheKey(gatewayId, gatewayRequest);
        const accumulator: SearchAccumulator = { games: [], partial: false };

        return resolved.driver.searchGames(gatewayRequest).pipe(
          // concatMap, not mergeMap: RESULT frames resolve dedup against the
          // DB while SOURCE_DONE maps synchronously — merged, the completion
          // frame overtakes still-pending RESULTs and consumers finalize the
          // source early. Serializing preserves gateway emission order (and
          // caps dedup concurrency on the live path as a side effect).
          concatMap((result: proto.GatewaySearchResult) =>
            this.mapGatewayResult(
              'Search',
              gatewayId,
              result,
              accumulator,
              cacheKey,
              resultFilter,
              resolved.contentFormat,
            ),
          ),
          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`gRPC stream error from gateway ${gatewayId}: ${message}`);

            return this.errorGameSearchResult(gatewayId, request.correlationId, message);
          }),
        );
      }),
      // Resolve/lazy-connect failure, or a refusal to route the search → the
      // DataGateway is unavailable, distinct from a mid-stream gRPC error
      // (handled above as ERROR).
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Gateway ${gatewayId} unavailable: ${message}`);

        return this.errorGameSearchResult(
          gatewayId,
          request.correlationId,
          this.unavailableMessage(gatewayId, err),
          proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        );
      }),
    );
  }

  /**
   * One frame of a DataGateway's live stream, for a search or an expansion
   * list (#1067) alike: its game accumulated for the cache and sent if the
   * filter matches, a status frame relayed and marking the list partial, and
   * the list cached on SOURCE_DONE. `what` only names the stream in the logs.
   */
  private mapGatewayResult(
    what: 'Search' | 'Expansions',
    gatewayId: string,
    result: proto.GatewaySearchResult,
    accumulator: SearchAccumulator,
    cacheKey: string,
    resultFilter: ResultFilter,
    contentFormat: ContentFormat | null,
  ): Observable<proto.SearchGameResult> {
    this.logger.debug(`Received search result from gateway ${gatewayId} with status ${result.status}`);
    const base = { correlationId: result.correlationId, gatewayId };

    if (
      result.status !== proto.ResultStatus.RESULT_STATUS_RESULT &&
      result.status !== proto.ResultStatus.RESULT_STATUS_SOURCE_DONE
    ) {
      accumulator.partial = true;
    }

    switch (result.status) {
      case proto.ResultStatus.RESULT_STATUS_RESULT: {
        if (!result.game) {
          this.logger.warn(`Received RESULT status from gateway ${gatewayId} without game data`);

          return EMPTY;
        }

        // The cache holds whatever the DataGateway answered, its summaries
        // unconverted, so the filter applies again on replay, and two
        // searches it would have answered alike share the entry.
        this.logger.debug(`Accumulating game with externalId ${result.game.externalId} from gateway ${gatewayId}`);
        accumulator.games.push(result.game);

        if (!matchesFilter(result.game, resultFilter)) {
          return EMPTY;
        }

        // Async dedup check
        return this.toResultFrame(gatewayId, result.correlationId, result.game, contentFormat);
      }

      case proto.ResultStatus.RESULT_STATUS_SOURCE_DONE: {
        this.logger.debug(`Gateway ${gatewayId} has completed sending results`);

        // Persist accumulated results to cache once the gateway signals
        // completion, unless it reported a problem first
        this.cacheUnlessPartial(what, gatewayId, cacheKey, accumulator);
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
          message: result.message,
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
   * Emit the cached GameSearchData frames the filter matches, followed by
   * SOURCE_DONE, running dedup fresh for each (cache doesn't store inSystem
   * — it changes over time).
   */
  private emitCachedResults(
    gatewayId: string,
    correlationId: string,
    cached: proto.GameSearchData[],
    resultFilter: ResultFilter,
    contentFormat: ContentFormat | null,
  ): Observable<proto.SearchGameResult> {
    const matching = cached.filter((game) => matchesFilter(game, resultFilter));

    const resultFrames$ = from(matching).pipe(
      // Bounded: an unbounded fan-out here issues one findUnique per cached
      // game simultaneously and can saturate the Prisma pool on hot queries.
      // endWith keeps SOURCE_DONE last regardless (appended on completion).
      mergeMap(
        (game: proto.GameSearchData) => this.toResultFrame(gatewayId, correlationId, game, contentFormat),
        DEDUP_CONCURRENCY,
      ),
    );

    return resultFrames$.pipe(
      endWith({
        correlationId,
        gatewayId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      }),
      tap(() =>
        this.logger.debug(`Emitted ${matching.length} of ${cached.length} cached results for gateway ${gatewayId}`),
      ),
    );
  }

  /**
   * Asks the DataGateway for a base game's expansions, or answers from the
   * cache with the list it gave within the last 5 minutes (#1067). It's resolved before the cache is
   * read, so one disabled, or no longer allowed to fetch expansions, since its
   * list was cached answers UNAVAILABLE, never the cached rows. Which rows are
   * already in the catalog is looked up fresh either way.
   */
  private fetchExpansionsFromGateway(
    gatewayId: string,
    baseExternalId: string,
    correlationId: string,
    locale?: string,
  ): Observable<proto.SearchGameResult> {
    const gatewayRequest: proto.FetchExpansionsRequest = { correlationId, baseExternalId, locale };
    const cacheKey = this.buildExpansionsCacheKey(gatewayId, gatewayRequest);

    return from(this.registry.resolveWithContentFormat(gatewayId, DataGatewayCapability.FetchExpansions)).pipe(
      mergeMap((resolution) =>
        from(this.cache.get<proto.GameSearchData[]>(cacheKey)).pipe(
          catchError((err) => {
            this.logger.warn(
              `Expansions cache read failed for gateway ${gatewayId}; falling through to live fetch: ${
                err instanceof Error ? err.message : err
              }`,
            );
            return of(undefined);
          }),
          // An expansion list has no search filter, so every cached row is sent.
          mergeMap((cached) =>
            cached === undefined
              ? this.fetchExpansionsLive(gatewayId, resolution, gatewayRequest, cacheKey)
              : this.emitCachedResults(gatewayId, correlationId, cached, {}, resolution.contentFormat),
          ),
          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            return this.errorGameSearchResult(gatewayId, correlationId, message);
          }),
        ),
      ),
      // Resolve/lazy-connect failure, or a refusal to route → DataGateway unavailable.
      catchError((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Gateway ${gatewayId} unavailable: ${message}`);

        return this.errorGameSearchResult(
          gatewayId,
          correlationId,
          this.unavailableMessage(gatewayId, err),
          proto.ResultStatus.RESULT_STATUS_UNAVAILABLE,
        );
      }),
    );
  }

  /**
   * The DataGateway's expansion list, live. Its frames are read as a search's
   * are, with no filter: an expansion list has none, so every row is sent.
   */
  private fetchExpansionsLive(
    gatewayId: string,
    { driver, contentFormat }: GatewayResolution,
    request: proto.FetchExpansionsRequest,
    cacheKey: string,
  ): Observable<proto.SearchGameResult> {
    const accumulator: SearchAccumulator = { games: [], partial: false };

    return driver.fetchExpansions(request).pipe(
      // Same ordering rationale as fetchFromGateway: async RESULT frames
      // must not be overtaken by synchronously-mapped status frames.
      concatMap((result: proto.GatewaySearchResult) =>
        this.mapGatewayResult('Expansions', gatewayId, result, accumulator, cacheKey, {}, contentFormat),
      ),
    );
  }

  /**
   * Writes one live stream's games to the cache, unless the DataGateway
   * reported a problem before it was done. A failed write is only logged.
   */
  private cacheUnlessPartial(
    what: 'Search' | 'Expansions',
    gatewayId: string,
    cacheKey: string,
    accumulator: SearchAccumulator,
  ): void {
    if (accumulator.partial) {
      return;
    }

    void this.cache
      .set(cacheKey, accumulator.games, this.searchCacheTTL)
      .catch((err) =>
        this.logger.warn(
          `${what} cache write failed for gateway ${gatewayId}: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

  /**
   * An UNAVAILABLE frame's message. A refusal to route says why, since it
   * names nothing about the DataGateway's own errors. Any other failure to
   * reach it stays a bare "not connected", and its detail goes to the log.
   */
  private unavailableMessage(gatewayId: string, err: unknown): string {
    return err instanceof GatewayRoutingRefusedError ? err.message : `DataGateway ${gatewayId} is not connected`;
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
   *
   * Its summary is sent as Markdown, converted from the DataGateway's content
   * format, as a stored description is (#714), so one renderer shows both.
   */
  private toResultFrame(
    gatewayId: string,
    correlationId: string,
    game: proto.GameSearchData,
    contentFormat: ContentFormat | null,
  ): Observable<proto.SearchGameResult> {
    const sent = { ...game, summary: convertToMarkdown(game.summary, contentFormat) };

    return from(this.resolveDedup(gatewayId, game.externalId)).pipe(
      map(
        ({ inSystem, gameId }): proto.SearchGameResult => ({
          correlationId,
          gatewayId,
          status: proto.ResultStatus.RESULT_STATUS_RESULT,
          game: sent,
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

  /**
   * What a DataGateway is asked: the search, with its filter cut to the axes
   * the DataGateway's search narrows by.
   */
  private gatewayRequest(
    request: proto.SearchGamesRequest,
    filterableAxes: readonly SearchFilterAxis[],
  ): proto.GatewaySearchRequest {
    const sentFilter = filterFor(request.filter, filterableAxes);

    return {
      correlationId: request.correlationId,
      query: request.query,
      limit: request.limit,
      offset: request.offset,
      locale: request.locale,
      ...(sentFilter && { filter: sentFilter }),
    };
  }

  /**
   * The answer of a DataGateway whose coverage doesn't overlap the search's
   * filter: nothing it has can match, so it isn't asked, and its part of the
   * search ends at once.
   */
  private uncoveredSearch(gatewayId: string, correlationId: string): Observable<proto.SearchGameResult> {
    this.logger.debug(`Gateway ${gatewayId} covers nothing the search's filter names; not asking it`);

    return of<proto.SearchGameResult>({
      correlationId,
      gatewayId,
      status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
    });
  }

  /**
   * The answer of a DataGateway that can't apply a range the search names
   * (#869). It doesn't promise that its results carry the value, so none can
   * be counted on to pass, and asking would spend an upstream call on results
   * the server would likely drop. It isn't asked, and nothing is cached for it.
   */
  private unfilterableSearch(
    gatewayId: string,
    correlationId: string,
    axes: readonly SearchFilterAxis[],
  ): Observable<proto.SearchGameResult> {
    this.logger.debug(
      `Gateway ${gatewayId} doesn't declare ${axes.join(', ')}, which the search's filter names; not asking it`,
    );

    return of<proto.SearchGameResult>({
      correlationId,
      gatewayId,
      status: proto.ResultStatus.RESULT_STATUS_UNFILTERABLE,
    });
  }

  /**
   * Keyed by what the DataGateway was asked, so a filter on an axis it
   * doesn't narrow by shares the entry with the unfiltered search: the
   * filter applies to the entry on the way out instead. A publish year it
   * narrows by keys the entry too, and whether it keeps unknown years: a
   * search that keeps them mustn't replay one that had them left out (#719).
   * So do a player count and a play time it narrows by (#869).
   */
  private buildSearchCacheKey(gatewayId: string, request: proto.GatewaySearchRequest): string {
    return [
      this.searchCachePrefix,
      gatewayId,
      encodeURIComponent(request.query),
      encodeURIComponent(request.locale ?? ''),
      request.limit ?? '',
      request.offset ?? '',
      request.filter?.platformTypes.join(',') ?? '',
      request.filter?.contentTypes.join(',') ?? '',
      request.filter?.publishYear?.min ?? '',
      request.filter?.publishYear?.max ?? '',
      request.filter?.publishYear?.includeUnknown ? 'u' : '',
      request.filter?.playerCount?.min ?? '',
      request.filter?.playerCount?.max ?? '',
      request.filter?.playerCount?.includeUnknown ? 'u' : '',
      request.filter?.playTime?.min ?? '',
      request.filter?.playTime?.max ?? '',
      request.filter?.playTime?.includeUnknown ? 'u' : '',
    ].join(':');
  }

  /**
   * Keyed by the DataGateway, the base game's external ID there and the
   * locale. The last two slots are for `limit` and `offset`, empty until the
   * request carries paging, so a later paged request is never answered with
   * the first page from the cache (#1067, #1092).
   */
  private buildExpansionsCacheKey(gatewayId: string, request: proto.FetchExpansionsRequest): string {
    return [
      this.expansionsCachePrefix,
      gatewayId,
      encodeURIComponent(request.baseExternalId),
      encodeURIComponent(request.locale ?? ''),
      '',
      '',
    ].join(':');
  }
}
