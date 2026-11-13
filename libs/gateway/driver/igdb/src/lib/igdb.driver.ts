import {
  unsupportedOperation,
  type DataGatewayDriver,
  type DriverLogger,
  type UpstreamFetch,
} from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { randomUUID } from 'node:crypto';
import { defer, EMPTY, from, merge, Observable, of } from 'rxjs';
import { catchError, endWith, expand, filter, map, mergeMap, reduce, shareReplay, tap } from 'rxjs/operators';
import type { IgdbRequest } from './client/igdb-client.interface';
import { IgdbCaller } from './igdb-caller';
import {
  IGDB_CONTENT_TYPES,
  IGDB_PLATFORM_TYPES,
  toCategoryData,
  toGameData,
  toGameSearchData,
  toPlatformData,
  toSearchNarrowing,
} from './mappers/game.mapper';
import { toGatewayLanguageEntries } from './mappers/language.mapper';
import { fetchExpansionsRequest, fetchGameRequest, searchGamesRequest } from './requests/game.requests';
import { IGDB_LIST_PAGE_SIZE, listGenresRequest, listPlatformsRequest } from './requests/vocabulary.requests';
import type { IgdbGame } from './types';

export interface IgdbDriverOptions {
  /** How the driver reaches IGDB and Twitch; it has no other way (#1082). */
  fetch: UpstreamFetch;
  clientId: string;
  clientSecret: string;

  /** Where the access token comes from. Defaults to Twitch's endpoint. */
  tokenUrl?: string;

  /**
   * The version Ping reports. The gateway app passes the BGE version; a
   * plugin DataGateway passes its plugin manifest's, so a new plugin version
   * is interviewed again.
   */
  version: string;
  logger: DriverLogger;

  /** IGDB's API. Defaults to `https://api.igdb.com/v4`. */
  baseUrl?: string;

  /** The driver's waits, which tests shorten. */
  timing?: {
    /** The wait before retrying a 429. Defaults to 1 second. */
    rateLimitRetryMs?: number;
  };
}

/**
 * IGDB as a DataGateway (#1082). The IGDB gateway app hosts it as a remote
 * DataGateway, and a plugin DataGateway will load it too. Call {@link start}
 * before anything else: it fetches the first access token.
 */
export class IgdbDriver implements DataGatewayDriver {
  private readonly caller: IgdbCaller;

  constructor(private readonly options: IgdbDriverOptions) {
    this.caller = new IgdbCaller({
      fetch: options.fetch,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      tokenUrl: options.tokenUrl,
      baseUrl: options.baseUrl,
      logger: options.logger,
      rateLimitRetryMs: options.timing?.rateLimitRetryMs,
    });
  }

  private get logger(): DriverLogger {
    return this.options.logger;
  }

  /** Fetches the first access token; fails when the token endpoint refuses. */
  start(): Promise<void> {
    return this.caller.start();
  }

  ping(request: proto.GatewayPingRequest): Observable<proto.GatewayPingResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayName: 'IgdbGateway',
      gatewayVersion: this.options.version,
    });
  }

  check(request: proto.HealthCheckRequest): Observable<proto.HealthCheckResponse> {
    this.logger.info(`Health check request from service: ${request.service}`);

    return of({
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    });
  }

  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      capabilities: [
        proto.Capability.CAPABILITY_SEARCH,
        proto.Capability.CAPABILITY_FETCH,
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
        // Its genres are the server's categories. IGDB has no mechanics (#718).
        proto.Capability.CAPABILITY_LIST_PLATFORMS,
        proto.Capability.CAPABILITY_LIST_CATEGORIES,
      ],

      coverage: { platformTypes: [...IGDB_PLATFORM_TYPES], contentTypes: [...IGDB_CONTENT_TYPES] },

      /**
       * Search narrows by both coverage axes, through IGDB's game types and
       * platform types, and by publish year, through each game's first
       * release date, its year read in UTC (see toSearchNarrowing).
       */
      filterableAxes: [
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PLATFORM_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_CONTENT_TYPE,
        proto.SearchFilterAxis.SEARCH_FILTER_AXIS_PUBLISH_YEAR,
      ],
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

      upstream: proto.Upstream.UPSTREAM_IGDB,
    });
  }

  listLanguages(request: proto.ListLanguagesRequest): Observable<proto.ListLanguagesResponse> {
    return of({
      correlationId: request.correlationId ?? randomUUID(),
      languages: toGatewayLanguageEntries(),
    });
  }

  /** Every platform IGDB has, mapped as a game's platforms are, so import finds each one linked (#718). */
  listPlatforms(request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    return this.listAll(listPlatformsRequest).pipe(
      map((platforms) => ({
        correlationId: request.correlationId ?? randomUUID(),
        platforms: platforms.map(toPlatformData),
      })),
    );
  }

  /** Every genre IGDB has, which the server stores as categories (#718). */
  listCategories(request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    return this.listAll(listGenresRequest).pipe(
      map((genres) => ({
        correlationId: request.correlationId ?? randomUUID(),
        categories: genres.map(toCategoryData),
      })),
    );
  }

  /** IGDB has no mechanics, so the driver declares none and answers UNIMPLEMENTED (#718). */
  listMechanics(_request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    return unsupportedOperation('ListMechanics');
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

    return this.caller
      .call(searchGamesRequest(request.query, request.limit ?? 20, request.offset ?? 0, request.locale, narrowing))
      .pipe(
        tap((games) => this.logger.info(`searchGames found ${games.length} results for query '${request.query}'`)),

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
    // Deferred, so a malformed external ID, which fetchGameRequest refuses when
    // it's built, lands in catchError as an ERROR frame (#1067).
    const gameRequest$ = defer(() => this.caller.call(fetchGameRequest(request.externalId, request.locale))).pipe(
      tap((games) =>
        this.logger.info(`fetchGame found ${games.length} results for externalId '${request.externalId}'`),
      ),
      // Counted, so when nothing listens any more the request stops too, rather
      // than the share keeping it open (#1082).
      shareReplay({ bufferSize: 1, refCount: true }),
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
    // Deferred, as fetchGame is: a malformed base external ID answers an ERROR frame (#1067).
    return defer(() => this.caller.call(fetchExpansionsRequest(request.baseExternalId, request.locale))).pipe(
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

  /** Nothing to release: the driver holds no connection, and the fetch it was handed isn't its own (#1082). */
  dispose(): void {
    return undefined;
  }

  /**
   * Every row of an IGDB list, asked a page at a time until a page comes back
   * short. The proto requires a list to be complete, so a page that fails
   * fails the whole list rather than answering part of it (#718).
   */
  private listAll<T>(page: (offset: number) => IgdbRequest<T[]>): Observable<T[]> {
    const ask = (offset: number) => this.caller.call(page(offset)).pipe(map((rows) => ({ offset, rows })));

    return ask(0).pipe(
      expand(({ offset, rows }) => (rows.length < IGDB_LIST_PAGE_SIZE ? EMPTY : ask(offset + IGDB_LIST_PAGE_SIZE))),
      reduce((all: T[], { rows }) => all.concat(rows), []),
    );
  }
}
