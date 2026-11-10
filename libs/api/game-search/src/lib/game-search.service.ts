import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, DatabaseService, type Prisma, ResourceType } from '@bge/database';
import { type DataGatewayLink, gameListScope, GameService } from '@bge/game';
import { t } from '@bge/i18n';
import { AbilityService, everyAbilityCan, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { ResultStatus, type SearchGameResult } from '@boardgamesempire/proto-gateway';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { defer, forkJoin, from, merge, Observable, of, timer } from 'rxjs';
import { catchError, map, mergeMap, takeUntil, tap, toArray } from 'rxjs/operators';
import type { ExpansionsQueryDto } from './dto/expansions-query.dto';
import type { WsGameSearchResult } from './dto/search-outbound.dto';
import type { SearchQueryDto } from './dto/search-query.dto';
import type { SearchResponseDto } from './dto/search-response.dto';
import type { SearchGamesResponse } from './interfaces';
import { type GameSearchFilter, localFilterConditions, toProtoSearchFilter } from './search-filter';

/**
 * Marks a `where` as {@link GameSearchService.localSearchScope}'s. Declared and
 * never present at runtime, like the catalog's `checkedAgainstSubject`: its one
 * job is that {@link GameSearchService.queryLocalGames} cannot be handed a
 * `where` built anywhere else. Neither the lint rule nor the list guard sees
 * that call, and `{}` would read every game, private and deleted alike (#472).
 */
declare const composedForLocalSearch: unique symbol;

/** The `where` a local title search reads within. Only {@link GameSearchService.localSearchScope} makes one. */
export type LocalSearchScope = Prisma.GameWhereInput & { readonly [composedForLocalSearch]: true };

@Injectable()
export class GameSearchService {
  private readonly logger = new Logger(GameSearchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly coordinator: GatewayCoordinatorClientService,
    private readonly ability: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly gameService: GameService,
  ) {}

  search(dto: SearchQueryDto): Observable<SearchResponseDto> {
    const correlationId = crypto.randomUUID();

    // Both checked here, outside each half's catchError: a refusal is an
    // authorization failure and must not come back as "no games found".
    if (dto.includeExternal !== false) {
      this.assertMayAskDataGateways();
    }

    const local$ = dto.includeLocal !== false ? this.searchLocal(dto, this.localSearchScope()) : of([]);
    const external$ = dto.includeExternal !== false ? this.searchExternal(correlationId, dto) : of(null);

    return forkJoin({ local: local$, external: external$ }).pipe(
      map(({ local, external }) => this.buildResponse(correlationId, local, external)),
    );
  }

  /**
   * A base game's expansions at its DataGateways (#1067), in search's
   * response shape. The base game is named by a DataGateway and its external
   * ID there, or by its ID on this server, which stands for each of its
   * DataGateway links. A game with none answers an empty result.
   *
   * The refusals are synchronous, as search's are, so none comes back as "no
   * expansions": an actor who may not ask the DataGateways, and a request
   * that names the base game both ways or neither. Reading the game's links
   * answers 404 or 403 as `GET /games/:id` does, uncaught for the same reason.
   */
  fetchExpansions(dto: ExpansionsQueryDto): Observable<SearchResponseDto> {
    this.assertMayAskDataGateways();

    const links$ = this.expansionsBaseGameLinks(dto);
    const correlationId = crypto.randomUUID();

    return links$.pipe(
      mergeMap((links) =>
        links.length === 0
          ? of<SearchGamesResponse>({ correlationId, results: [] })
          : this.fetchExternalExpansions(correlationId, links, dto.locale),
      ),
      map((external) => this.buildResponse(correlationId, [], external)),
    );
  }

  /**
   * The `where` a local title search reads within: the set
   * {@link gameListScope} names, clipped by the acting user's ceiling.
   * It is the set `GET /games` lists (#513).
   *
   * Synchronous, and each transport calls it before its search begins, for
   * the same reason: a refusal here is an authorization failure. Built inside
   * the search, it would come back as "no games found" over REST, and as a
   * failed local search over WebSocket.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * half the scope is the caller's own games, which has no meaning without a
   * user. PROVISIONAL — #395.
   */
  localSearchScope(): LocalSearchScope {
    const userId = resolveScopeSubjectId(this.ability);

    return this.scopeComposer.compose(ResourceType.Game, Action.read, gameListScope(userId)) as LocalSearchScope;
  }

  /**
   * Refuses an actor who may not ask the DataGateways (#1076). Asking them
   * sends the query upstream on the server's credentials, so it takes
   * `read:data_gateway:search`, which every signed-in user holds and an
   * anonymous user does not. Like {@link localSearchScope}, each transport
   * calls it before its search begins, whenever the DataGateways are asked
   * for, which they are unless `includeExternal` is `false`.
   *
   * Every primed ability must allow it, so an API key and its owner are
   * checked together, as `PoliciesGuard` checks them (`everyAbilityCan`).
   */
  assertMayAskDataGateways(): void {
    if (!everyAbilityCan(this.ability.getCurrentAbilities(), Action.read, ResourceType.DataGatewaySearch)) {
      throw new ForbiddenException(t('errors.game_search.data_gateways_forbidden'));
    }
  }

  private searchLocal(dto: SearchQueryDto, scope: LocalSearchScope): Observable<WsGameSearchResult[]> {
    return from(this.queryLocalGames(dto.query, scope, dto.pageSize, dto.offset, dto)).pipe(
      catchError((err) => {
        this.logger.error('Local search failed', err);
        return of([]);
      }),
    );
  }

  /**
   * Runs the local-DB title search and maps each row into a WsGameSearchResult.
   * Shared by the REST search path ({@link searchLocal}) and the WS
   * GameSearchGateway so the query/select and row→DTO mapping live in one place.
   * Rejects on DB error; callers decide how to surface it (REST swallows to `[]`,
   * WS emits a SearchError frame).
   *
   * `scope` is the caller's {@link localSearchScope}, and it is required
   * rather than built here so that a refusal to build it never reaches the
   * callers' failure handling. Its type admits nothing else
   * ({@link LocalSearchScope}): without it a title search reads every private
   * game (#472).
   *
   * `limit` and `offset` are required too: each caller passes its DTO's
   * resolved `pageSize` and `offset`, so the default page size is the DTO's,
   * not a fallback here (#403). So is `filter`, each caller's DTO, which the
   * local half honors as the DataGateways' results do (#713).
   */
  async queryLocalGames(
    query: string,
    scope: LocalSearchScope,
    limit: number,
    offset: number,
    filter: GameSearchFilter,
  ): Promise<WsGameSearchResult[]> {
    this.logger.debug(`Performing local search for query="${query}" with limit=${limit} and offset=${offset}`);

    const games = await this.db.game.findMany({
      where: {
        AND: [scope, { title: { contains: query, mode: 'insensitive' } }, ...localFilterConditions(filter)],
      },

      take: limit,
      skip: offset,

      select: {
        id: true,
        title: true,
        contentType: true,
        publishYear: true,
        thumbnail: true,
        averageRating: true,
        minPlayers: true,
        maxPlayers: true,
        minPlayTime: true,
        maxPlayTime: true,

        gameSources: {
          select: { sourceUrl: true },
          take: 1,
        },

        platformGames: {
          select: {
            id: true,

            platform: {
              select: {
                id: true,
                name: true,
                abbreviation: true,
                platformType: true,

                gatewayLinks: {
                  select: {
                    gatewayId: true,
                    externalId: true,
                  },
                },
              },
            },

            releases: {
              select: {
                region: true,
                releaseDate: true,
                status: true,

                languages: {
                  select: {
                    languageTag: {
                      select: {
                        tag: true,
                        name: true,
                        language: {
                          select: {
                            iso6393: true,
                            iso6391: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return games.map(
      (game): WsGameSearchResult => ({
        externalId: game.id,
        title: game.title,
        contentType: game.contentType,
        yearPublished: game.publishYear ?? undefined,
        thumbnailUrl: game.thumbnail || undefined,
        sourceUrl: game.gameSources?.[0]?.sourceUrl || undefined,
        averageRating: game.averageRating ?? undefined,
        minPlayers: game.minPlayers ?? undefined,
        maxPlayers: game.maxPlayers ?? undefined,
        minPlayTime: game.minPlayTime ?? undefined,
        maxPlayTime: game.maxPlayTime ?? undefined,
        baseGameExternalIds: [],
        inSystem: true,
        gameId: game.id,

        platforms: game.platformGames?.map((pg) => ({
          externalId: pg.platform.id,
          name: pg.platform.name,
          abbreviation: pg.platform.abbreviation ?? undefined,
          platformType: pg.platform.platformType.toString(),
        })),

        availableReleases: game.platformGames?.flatMap((pg) =>
          pg.releases.map((r) => ({
            externalId: pg.platform.id,
            platform: {
              externalId: pg.platform.gatewayLinks[0]?.externalId || undefined,
              name: pg.platform.name,
              abbreviation: pg.platform.abbreviation ?? undefined,
              platformType: pg.platform.platformType.toString(),
            },

            status: r.status,
            releaseDate: r.releaseDate?.toISOString().split('T')[0] ?? undefined,
            languages: r.languages.map((l) => ({
              tag: l.languageTag.tag,
              iso6393: l.languageTag.language.iso6393,
              iso6391: l.languageTag.language.iso6391 ?? undefined,
              name: l.languageTag.name,
            })),
          })),
        ),
      }),
    );
  }

  private searchExternal(correlationId: string, dto: SearchQueryDto): Observable<SearchGamesResponse> {
    return this.coordinator
      .searchGames({
        correlationId,
        query: dto.query,
        gatewayIds: dto.gatewayIds ?? [],
        limit: dto.limit,
        offset: dto.offset,
        locale: dto.locale,
        filter: toProtoSearchFilter(dto),
      })
      .pipe(
        takeUntil(timer(15000)),
        toArray(),
        map<SearchGameResult[], SearchGamesResponse>((results) => ({
          correlationId,
          results,
        })),
        catchError((err) => {
          this.logger.error('External search failed', err);
          return of({ correlationId, results: [] } satisfies SearchGamesResponse);
        }),
      );
  }

  /**
   * The DataGateway links to ask for the base game's expansions: the one the
   * request names, or each of the game's. Throws a 400, synchronously, unless
   * the base game is named exactly one way. A field sent as JSON null counts
   * as left out, as one never sent does.
   */
  private expansionsBaseGameLinks({
    gatewayId,
    externalId,
    gameId,
  }: ExpansionsQueryDto): Observable<DataGatewayLink[]> {
    if (gameId != null && gatewayId == null && externalId == null) {
      return defer(() => this.gameService.readDataGatewayLinks(gameId));
    }

    if (gatewayId != null && externalId != null && gameId == null) {
      return of([{ gatewayId, externalId }]);
    }

    throw new BadRequestException(t('errors.game_search.expansions_target_exactly_one'));
  }

  /**
   * Asks the coordinator once per DataGateway link, and stops at 15 s, as
   * REST search does. A link whose call fails answers its DataGateway as
   * unavailable, its detail logged, so the other links' rows still arrive and
   * the failure doesn't read as "no expansions". So does a link still being
   * answered at 15 s: the rows it sent are kept, but its list isn't whole.
   * Two links on one DataGateway can list the same expansion, or both answer
   * it unavailable: each row and each status is kept once per DataGateway.
   */
  private fetchExternalExpansions(
    correlationId: string,
    links: DataGatewayLink[],
    locale: string | undefined,
  ): Observable<SearchGamesResponse> {
    return defer(() => {
      // The links whose coordinator call ended before the deadline.
      const finished = new Set<number>();

      const perLink = links.map(({ gatewayId, externalId }, index) =>
        defer(() =>
          this.coordinator.fetchExpansions({ correlationId, gatewayId, baseExternalId: externalId, locale }),
        ).pipe(
          catchError((err) => {
            this.logger.error(`Expansions fetch failed for DataGateway ${gatewayId}`, err);
            return of<SearchGameResult>({ correlationId, gatewayId, status: ResultStatus.RESULT_STATUS_UNAVAILABLE });
          }),
          tap({ complete: () => finished.add(index) }),
        ),
      );

      return merge(...perLink).pipe(
        takeUntil(timer(15000)),
        toArray(),
        map<SearchGameResult[], SearchGamesResponse>((results) => {
          const unfinished = links
            .filter((_, index) => !finished.has(index))
            .map(({ gatewayId }): SearchGameResult => {
              this.logger.warn(`Expansions fetch for DataGateway ${gatewayId} didn't finish within 15 s`);
              return { correlationId, gatewayId, status: ResultStatus.RESULT_STATUS_UNAVAILABLE };
            });

          return { correlationId, results: oncePerDataGateway([...results, ...unfinished]) };
        }),
      );
    });
  }

  private buildResponse(
    correlationId: string,
    localResults: WsGameSearchResult[],
    externalResponse: SearchGamesResponse | null,
  ): SearchResponseDto {
    const resultsBySource: Record<string, WsGameSearchResult[]> = {};
    const errors: Record<string, { message: string }> = {};
    const rateLimitedSources: string[] = [];
    const unavailableSources: string[] = [];
    const unfilterableSources: string[] = [];

    if (localResults.length > 0) {
      resultsBySource['local'] = localResults;
    }

    if (externalResponse) {
      for (const result of externalResponse.results) {
        const source = result.gatewayId;
        if (!source) continue;

        switch (result.status) {
          case ResultStatus.RESULT_STATUS_RESULT: {
            if (!result.game) break;

            if (!resultsBySource[source]) {
              resultsBySource[source] = [];
            }

            resultsBySource[source].push(this.mapProtoGame(result));
            break;
          }

          case ResultStatus.RESULT_STATUS_ERROR: {
            errors[source] = { message: result.message ?? 'Unknown error' };
            break;
          }

          case ResultStatus.RESULT_STATUS_RATE_LIMITED: {
            rateLimitedSources.push(source);
            break;
          }

          case ResultStatus.RESULT_STATUS_UNAVAILABLE: {
            unavailableSources.push(source);
            break;
          }

          // A DataGateway the search's filter skipped (#869). Without a note
          // of it, a player-count or play-time search would show each such
          // DataGateway as having found nothing.
          case ResultStatus.RESULT_STATUS_UNFILTERABLE: {
            unfilterableSources.push(source);
            break;
          }
        }
      }
    }

    return {
      correlationId,
      resultsBySource,
      ...(Object.keys(errors).length > 0 && { errors }),
      ...(rateLimitedSources.length > 0 && { rateLimitedSources }),
      ...(unavailableSources.length > 0 && { unavailableSources }),
      ...(unfilterableSources.length > 0 && { unfilterableSources }),
    };
  }

  /**
   * Maps a coordinator RESULT_STATUS_RESULT frame into a WsGameSearchResult.
   * Shared by the REST {@link buildResponse} and the WS GameSearchGateway so the
   * proto→DTO mapping lives in one place. The caller must have checked that
   * `result.game` is present (RESULT_STATUS_RESULT).
   */
  mapProtoGame(result: SearchGameResult): WsGameSearchResult {
    const game = result.game!;

    return {
      externalId: game.externalId,
      title: game.title,
      contentType: game.contentType.toString(),
      yearPublished: game.yearPublished,
      thumbnailUrl: game.thumbnailUrl,
      sourceUrl: game.sourceUrl,
      summary: game.summary,
      averageRating: game.averageRating,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      minPlayTime: game.minPlaytime,
      maxPlayTime: game.maxPlaytime,
      baseGameExternalIds: game.baseGameExternalIds ?? [],
      inSystem: result.inSystem ?? false,
      gameId: result.gameId,

      platforms: (game.availablePlatforms ?? []).map((p) => ({
        externalId: p.externalId,
        name: p.name,
        abbreviation: p.abbreviation,
        platformType: p.platformType.toString(),
      })),

      availableReleases: (game.availableReleases ?? []).map((r) => ({
        externalId: r.externalId,
        platform: {
          ...r.platform!,
        },
        status: r.status.toString(),
        releaseDate: r.releaseDate,
        languages: (r.languages ?? []).map((l) => ({
          tag: l.ietfTag,
          iso6393: l.iso6393,
          iso6391: l.iso6391,
          name: l.name,
        })),
      })),
    };
  }
}

/**
 * The frames with each row kept once per DataGateway and external ID, and
 * each status once per DataGateway, in the order they arrived (#1067).
 */
function oncePerDataGateway(results: SearchGameResult[]): SearchGameResult[] {
  const seen = new Set<string>();

  return results.filter((result) => {
    const key = JSON.stringify(
      result.status === ResultStatus.RESULT_STATUS_RESULT && result.game
        ? [result.gatewayId, 'row', result.game.externalId]
        : [result.gatewayId, 'status', result.status],
    );

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
