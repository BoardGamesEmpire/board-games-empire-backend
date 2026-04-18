import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { DatabaseService } from '@bge/database';
import { ResultStatus, type SearchGameResult } from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { forkJoin, from, Observable, of, timer } from 'rxjs';
import { catchError, map, takeUntil, toArray } from 'rxjs/operators';
import type { WsGameSearchResult } from './dto/search-outbound.dto';
import type { SearchQueryDto } from './dto/search-query.dto';
import type { SearchResponseDto } from './dto/search-response.dto';
import type { SearchGamesResponse } from './interfaces';

@Injectable()
export class GameSearchService {
  private readonly logger = new Logger(GameSearchService.name);

  constructor(private readonly db: DatabaseService, private readonly coordinator: GatewayCoordinatorClientService) {}

  search(dto: SearchQueryDto): Observable<SearchResponseDto> {
    const correlationId = crypto.randomUUID();

    const local$ = dto.includeLocal !== false ? this.searchLocal(dto) : of([]);
    const external$ = dto.includeExternal !== false ? this.searchExternal(correlationId, dto) : of(null);

    return forkJoin({ local: local$, external: external$ }).pipe(
      map(({ local, external }) => this.buildResponse(correlationId, local, external)),
    );
  }

  private searchLocal(dto: SearchQueryDto): Observable<WsGameSearchResult[]> {
    const { query, limit = 20, offset = 0 } = dto;

    this.logger.debug(`Performing local search for query="${query}" with limit=${limit} and offset=${offset}`);

    return from(
      this.db.game.findMany({
        where: {
          deletedAt: null,
          title: { contains: query, mode: 'insensitive' },
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

          gameSources: {
            select: { sourceUrl: true },
            take: 1,
          },

          releases: {
            select: {
              region: true,
              releaseDate: true,
              status: true,

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

              languages: {
                select: {
                  language: {
                    select: {
                      code: true,
                      abbreviation: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).pipe(
      map((games) =>
        games.map(
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
            inSystem: true,
            gameId: game.id,

            platforms: game.releases.map((r) => ({
              externalId: r.platform.id,
              name: r.platform.name,
              abbreviation: r.platform.abbreviation ?? undefined,
              platformType: r.platform.platformType.toString(),
            })),

            availableReleases: game.releases.map((r) => ({
              externalId: r.platform.id,
              platform: {
                externalId: r.platform.gatewayLinks[0]?.externalId || undefined,
                name: r.platform.name,
                abbreviation: r.platform.abbreviation ?? undefined,
                platformType: r.platform.platformType.toString(),
              },

              status: r.status,
              releaseDate: r.releaseDate?.toISOString().split('T')[0] ?? undefined,
              languages: r.languages.map((l) => ({
                iso6393: l.language.code,
                iso6391: l.language.abbreviation ?? undefined,
                name: l.language.name,
              })),
            })),
          }),
        ),
      ),
      catchError((err) => {
        this.logger.error('Local search failed', err);
        return of([]);
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

  private buildResponse(
    correlationId: string,
    localResults: WsGameSearchResult[],
    externalResponse: SearchGamesResponse | null,
  ): SearchResponseDto {
    const resultsBySource: Record<string, WsGameSearchResult[]> = {};
    const errors: Record<string, { message: string }> = {};
    const rateLimitedSources: string[] = [];
    const unavailableSources: string[] = [];

    this.logger.debug(
      `Building search response for correlationId=${correlationId} with ${
        localResults?.length ?? 0
      } local results and ${externalResponse?.results.length ?? 0} external frames`,
    );

    if (localResults.length > 0) {
      resultsBySource['local'] = localResults;
    }

    if (externalResponse) {
      for (const frame of externalResponse.results) {
        this.classifyFrame(frame, resultsBySource, errors, rateLimitedSources, unavailableSources);
      }
    }

    return {
      correlationId,
      resultsBySource,
      ...(Object.keys(errors).length > 0 && { errors }),
      ...(rateLimitedSources.length > 0 && { rateLimitedSources }),
      ...(unavailableSources.length > 0 && { unavailableSources }),
    };
  }

  private classifyFrame(
    frame: SearchGameResult,
    resultsBySource: Record<string, WsGameSearchResult[]>,
    errors: Record<string, { message: string }>,
    rateLimitedSources: string[],
    unavailableSources: string[],
  ): void {
    const source = frame.gatewayId;

    switch (frame.status) {
      case ResultStatus.RESULT_STATUS_RESULT: {
        if (!frame.game) break;

        const bucket = (resultsBySource[source] ??= []);
        bucket.push({
          externalId: frame.game.externalId,
          title: frame.game.title,
          contentType: frame.game.contentType.toString(),
          yearPublished: frame.game.yearPublished,
          thumbnailUrl: frame.game.thumbnailUrl,
          sourceUrl: frame.game.sourceUrl,
          averageRating: frame.game.averageRating,
          minPlayers: frame.game.minPlayers,
          maxPlayers: frame.game.maxPlayers,
          baseGameExternalId: frame.game.baseGameExternalId,
          inSystem: frame.inSystem ?? false,
          gameId: frame.gameId,
          platforms: (frame.game.availablePlatforms ?? []).map((p) => ({
            externalId: p.externalId,
            name: p.name,
            abbreviation: p.abbreviation,
            platformType: p.platformType.toString(),
          })),
          availableReleases: (frame.game.availableReleases ?? []).map((r) => ({
            externalId: r.externalId,
            platform: {
              externalId: r.platform?.externalId,
              name: r.platform?.name ?? '',
              abbreviation: r.platform?.abbreviation,
              platformType: r.platform?.platformType?.toString() ?? '',
            },
            status: r.status?.toString() ?? '',
            releaseDate: r.releaseDate,
            languages: (r.languages ?? []).map((l) => ({
              iso6393: l.iso6393,
              iso6391: l.iso6391,
              name: l.name,
            })),
          })),
        });
        break;
      }

      case ResultStatus.RESULT_STATUS_ERROR:
        errors[source] = { message: frame.message ?? 'Unknown error' };
        break;

      case ResultStatus.RESULT_STATUS_RATE_LIMITED:
        rateLimitedSources.push(source);
        break;

      case ResultStatus.RESULT_STATUS_UNAVAILABLE:
        unavailableSources.push(source);
        break;

      case ResultStatus.RESULT_STATUS_SOURCE_DONE:
        // No-op for REST — SOURCE_DONE is a streaming protocol concern
        break;

      default:
        this.logger.warn(`Unhandled frame status ${frame.status} from ${source}`);
    }
  }
}
