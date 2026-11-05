import type { DataGatewayDriver, DriverLogger, UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { randomUUID } from 'node:crypto';
import { defer, EMPTY, from, Observable, of, throwError } from 'rxjs';
import { catchError, endWith, map, mergeMap, tap, timeout, toArray } from 'rxjs/operators';
import { BggCaller } from './bgg-caller';
import { createBggClient } from './client/bgg-client';
import { BggThingType, DEFAULT_BGG_SEARCH_TYPES, MAX_THINGS_PER_BATCH } from './constants';
import {
  getOutboundExpansionIds,
  searchItemToGameSearchData,
  TABLETOP_PLATFORM,
  thingToGameData,
  thingToGameSearchData,
  toContentTypes,
  toThingTypes,
} from './mappers/game.mapper';
import { toGatewayLanguageEntries } from './mappers/language.mapper';
import { toCategoryList, toMechanicList } from './mappers/taxonomy.mapper';
import {
  chunk,
  fetchThingRequest,
  fetchThingsRequest,
  parseExternalId,
  searchGamesRequest,
  type ThingFetchOptions,
} from './requests/game.requests';
import type { BggSearchItem, BggThing } from './types';

const FETCH_GAME_TYPES = [BggThingType.BoardGame, BggThingType.BoardGameExpansion] as const;
const EXPANSION_BATCH_TYPES = [BggThingType.BoardGameExpansion] as const;

/** What search asks `/thing` for to fill a page's results in: ratings, and no versions (#880). */
const SEARCH_THING_OPTIONS: ThingFetchOptions = { stats: 1, versions: 0, types: FETCH_GAME_TYPES };

/**
 * How long after a search begins its page's `/thing` batches may run before
 * their results go out as search found them. The page waits on every batch,
 * so a stalled one would hold back results search already has (#880).
 *
 * It counts from the start of the search because the api's REST search stops
 * listening 15 seconds in (`GameSearchService.searchExternal`), and search can
 * use much of that: the client waits 6 seconds on each 202 from BGG. This
 * leaves the results time to reach the api. A batch of 20 was measured at about
 * half a second, so a quick search leaves room for a rate limit's retry or a 202.
 */
const SEARCH_THINGS_DEADLINE_MS = 12_000;

export interface BoardGameGeekDriverOptions {
  /** How the driver reaches BGG; it has no other way (#1082). */
  fetch: UpstreamFetch;
  apiKey: string;

  /**
   * The version Ping reports. The gateway app passes the BGE version; a
   * plugin DataGateway passes its plugin manifest's, so a new plugin version
   * is interviewed again.
   */
  version: string;
  logger: DriverLogger;

  /** BGG's XML API 2. Defaults to `https://boardgamegeek.com/xmlapi2`. */
  baseUrl?: string;

  /** The driver's waits, which tests shorten. Each defaults to what BGG needs. */
  timing?: {
    /** The wait before retrying a 429 whose `Retry-After` names none. Defaults to 2 seconds. */
    rateLimitRetryMs?: number;

    /** The wait before asking again after a 202. Defaults to 6 seconds. */
    acceptedRetryMs?: number;

    /** How many times to ask again after a 202. Defaults to 5. */
    acceptedRetries?: number;

    /** How long from a search's start its details may take. Defaults to 12 seconds. */
    searchThingsDeadlineMs?: number;
  };
}

/**
 * BoardGameGeek as a DataGateway (#1082). The BoardGameGeek gateway app hosts
 * it as a remote DataGateway, and a plugin DataGateway will load it too.
 */
export class BoardGameGeekDriver implements DataGatewayDriver {
  private readonly caller: BggCaller;
  private readonly searchThingsDeadlineMs: number;

  constructor(private readonly options: BoardGameGeekDriverOptions) {
    const { timing } = options;

    const client = createBggClient({
      fetch: options.fetch,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      acceptedRetryMs: timing?.acceptedRetryMs,
      acceptedRetries: timing?.acceptedRetries,
    });

    this.caller = new BggCaller(client, options.logger, { rateLimitRetryMs: timing?.rateLimitRetryMs });
    this.searchThingsDeadlineMs = timing?.searchThingsDeadlineMs ?? SEARCH_THINGS_DEADLINE_MS;
  }

  private get logger(): DriverLogger {
    return this.options.logger;
  }

  ping(request: proto.GatewayPingRequest): Observable<proto.GatewayPingResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'BoardGameGeekGateway',
      gatewayVersion: this.options.version,
    } satisfies proto.GatewayPingResponse);
  }

  check(request: proto.HealthCheckRequest): Observable<proto.HealthCheckResponse> {
    this.logger.info(`Health check request from service: ${request.service}`);

    return of({
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    } satisfies proto.HealthCheckResponse);
  }

  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
        proto.Capability.CAPABILITY_LIST_PLATFORMS,
        proto.Capability.CAPABILITY_LIST_CATEGORIES,
        proto.Capability.CAPABILITY_LIST_MECHANICS,
      ],

      /** The kinds of thing search and fetch ask BGG for, as the game mapper types them. */
      coverage: {
        platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
        contentTypes: toContentTypes([...DEFAULT_BGG_SEARCH_TYPES, ...FETCH_GAME_TYPES, ...EXPANSION_BATCH_TYPES]),
      },

      /**
       * Search narrows by content type through the thing types it asks BGG
       * for. Its coverage is tabletop alone, which settles platform type. It
       * narrows by publish year too: BGG pages in memory, so the range applies
       * before paging and pages fill with games in it (#719).
       */
      filterableAxes: [
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
      ],

      /**
       * BGG accepts and emits English language display names ("English",
       * "Afrikaans"); not BCP 47 or ISO codes.
       */
      languageCodeFormats: {
        acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME],
        responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME,
        passthroughSearchLanguage: false,
      },

      /** BGG's descriptions carry no markup. */
      contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
    } satisfies proto.DescribeResponse);
  }

  listLanguages(request: proto.ListLanguagesRequest): Observable<proto.ListLanguagesResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      languages: toGatewayLanguageEntries(),
    } satisfies proto.ListLanguagesResponse);
  }

  /** Its one platform, Tabletop, which every game it sends is on (#718). */
  listPlatforms(request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      platforms: [TABLETOP_PLATFORM],
    } satisfies proto.ListPlatformsResponse);
  }

  /** Its categories, from the table copied from BGG's browse page, since its API lists none (#839). */
  listCategories(request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      categories: toCategoryList(),
    } satisfies proto.ListCategoriesResponse);
  }

  /** Its mechanics, from the table copied from BGG's browse page, since its API lists none (#839). */
  listMechanics(request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      mechanics: toMechanicList(),
    } satisfies proto.ListMechanicsResponse);
  }

  /**
   * Searches BGG for the request's query. A filter on content types narrows
   * the thing types search keeps; BGG itself is always asked for both, since
   * it labels expansions as base games in a base-game search (#777). A filter
   * naming nothing BGG has ends the search at once, without asking BGG. A
   * publish-year range narrows the games it keeps before they're paged (#719).
   * Each page's results are filled in from their things, and a failed lookup
   * sends them as search found them (#880).
   */
  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    const limit = request.limit ?? undefined;
    const offset = request.offset ?? undefined;
    const contentTypes = request.filter?.contentTypes ?? [];
    const types =
      contentTypes.length > 0 ? toThingTypes(contentTypes, DEFAULT_BGG_SEARCH_TYPES) : DEFAULT_BGG_SEARCH_TYPES;

    if (types.length === 0) {
      return of({
        correlationId: request.correlationId,
        status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE,
      } satisfies proto.GatewaySearchResult);
    }

    const search = searchGamesRequest(request.query, limit, offset, types, request.filter?.publishYear);
    const thingsDeadline = new Date(Date.now() + this.searchThingsDeadlineMs);

    return this.caller.call(search).pipe(
      tap((items) => this.logger.info(`searchGames found ${items.length} results for query '${request.query}'`)),

      mergeMap((items) => this.withThings(items, request.query, thingsDeadline)),
      map(
        (game) =>
          ({
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_RESULT,
            game,
          }) satisfies proto.GatewaySearchResult,
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
   * A page's results in search order, each filled in from its thing (#880).
   *
   * The things are asked for in batches of MAX_THINGS_PER_BATCH, all at once,
   * each through its own `caller.call` and so its own retry boundary. A
   * batch that still fails or runs out of time logs a warning and sends its
   * results as search found them, leaving the other batches' alone; so does a
   * result whose thing BGG's answer leaves out or that can't be read. An empty
   * page asks BGG nothing, and neither does a search that used up the time.
   */
  private withThings(
    items: BggSearchItem[],
    queryForLogging: string,
    deadline: Date,
  ): Observable<proto.GameSearchData> {
    const batches = chunk(
      items.map((item) => item.id),
      MAX_THINGS_PER_BATCH,
    );

    return from(batches).pipe(
      mergeMap((batch) =>
        this.thingsBefore(deadline, batch).pipe(
          tap((things) => {
            const answered = new Set(things.map((thing) => thing.id));
            const missing = batch.filter((id) => !answered.has(id));

            if (missing.length > 0) {
              this.logger.warn(
                `searchGames sent results without details for query '${queryForLogging}': BGG left out ${missing.join(', ')}`,
              );
            }
          }),

          catchError((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`searchGames sent results without details for query '${queryForLogging}': ${message}`);

            return of<BggThing[]>([]);
          }),
        ),
      ),
      toArray(),
      mergeMap((answers) => {
        const thingsById = new Map(answers.flat().map((thing) => [thing.id, thing]));
        return items.map((item) => this.fillIn(item, thingsById.get(item.id), queryForLogging));
      }),
    );
  }

  /** A batch's things, failing at the deadline, without asking BGG if it has passed (#880). */
  private thingsBefore(deadline: Date, batch: number[]): Observable<BggThing[]> {
    if (Date.now() >= deadline.getTime()) {
      return throwError(() => new Error('search left no time to ask for details'));
    }

    return this.caller.call(fetchThingsRequest(batch, SEARCH_THING_OPTIONS)).pipe(timeout({ first: deadline }));
  }

  /**
   * A result filled in from its thing, or as search found it when the thing
   * can't be read: one game's details shouldn't fail a search that succeeded
   * (#880).
   */
  private fillIn(item: BggSearchItem, thing: BggThing | undefined, queryForLogging: string): proto.GameSearchData {
    try {
      return searchItemToGameSearchData(item, thing);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `searchGames sent results without details for query '${queryForLogging}': couldn't read ${item.id}: ${message}`,
      );

      return searchItemToGameSearchData(item);
    }
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    return defer(() => {
      const externalId = parseExternalId(request.externalId);
      return this.caller.call(
        fetchThingRequest(externalId, {
          stats: 1,
          versions: 1,
          types: FETCH_GAME_TYPES,
        }),
      );
    }).pipe(
      tap((thing) =>
        this.logger.info(
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

        const gameData = thingToGameData(thing, request.locale);
        this.logger.debug(
          `fetchGame mapped BGG thing to GameData: ${gameData.title} (externalId: ${gameData.externalId}, releases: ${gameData.releases.length})`,
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
   *   1. One `caller.call` for the base thing — its own retry boundary.
   *   2. Outbound expansion ids are split into batches of size
   *      MAX_THINGS_PER_BATCH.
   *   3. Each batch flows through its own `caller.call` — also its own
   *      retry boundary, so a 429 on batch 3 of 5 retries only batch 3
   *      rather than re-running the entire fetch.
   *
   * If the base thing is missing or has no outbound expansion links,
   * only SOURCE_DONE is emitted (no error). If any single batch fails
   * after its retry is exhausted, the whole stream fails with an ERROR
   * frame — partial-success is not modeled at this layer.
   */
  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    return defer(() => {
      const baseId = parseExternalId(request.baseExternalId);

      return this.caller
        .call(
          fetchThingRequest(baseId, {
            types: FETCH_GAME_TYPES,
            versions: 0,
          }),
        )
        .pipe(mergeMap((base) => this.streamExpansionsFromBase(base, request.baseExternalId)));
    }).pipe(
      map(
        (thing) =>
          ({
            correlationId: request.correlationId,
            status: proto.ResultStatus.RESULT_STATUS_RESULT,
            game: thingToGameSearchData(thing),
          }) satisfies proto.GatewaySearchResult,
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

  /** Nothing to release: the driver holds no connection, and the fetch it was handed isn't its own (#1082). */
  dispose(): void {
    return undefined;
  }

  /**
   * Given the base thing, streams each outbound expansion thing one at
   * a time. Expansion ids are batched at MAX_THINGS_PER_BATCH and each
   * batch goes through its own `caller.call` so retries are scoped
   * per-batch.
   *
   * Returns EMPTY (which becomes just a SOURCE_DONE upstream) when:
   *  - the base thing is undefined (id not in BGG),
   *  - the base thing has no outbound expansion links.
   */
  private streamExpansionsFromBase(base: BggThing | undefined, baseExternalIdForLogging: string): Observable<BggThing> {
    if (!base) {
      this.logger.info(`fetchExpansions found no base game for baseExternalId '${baseExternalIdForLogging}'`);
      return EMPTY;
    }

    const expansionIds = getOutboundExpansionIds(base);
    this.logger.info(
      `fetchExpansions found ${expansionIds.length} expansion ids for baseExternalId '${baseExternalIdForLogging}'`,
    );

    if (expansionIds.length === 0) {
      return EMPTY;
    }

    const batches = chunk(expansionIds, MAX_THINGS_PER_BATCH);

    // mergeMap fans the batches out concurrently. Each batch is a
    // separate caller.call() — independent retry boundary.
    return from(batches).pipe(
      mergeMap((batch) =>
        this.caller.call(
          fetchThingsRequest(batch, {
            stats: 0,
            versions: 0,
            types: EXPANSION_BATCH_TYPES,
          }),
        ),
      ),
      mergeMap((things) => from(things)),
    );
  }
}
