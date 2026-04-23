import { AuthService } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { DatabaseService } from '@bge/database';
import type {
  WsClientData,
  WsGameSearchResult,
  WsRateLimitedPayload,
  WsSearchDonePayload,
  WsSearchErrorPayload,
  WsSearchResultPayload,
  WsSourceDonePayload,
  WsSourceUnavailablePayload,
} from '@bge/game-search';
import { SearchCancelDto, SearchEvents, SearchStartDto } from '@bge/game-search';
import { ResultStatus } from '@board-games-empire/proto-gateway';
import { Logger, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { wrapDefaults } from '@status/defaults';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '../base/authenticated.gateway';
import { WsAuthFilter, WsValidationFilter } from '../filters';

@UseGuards(AuthGuard)
@UseFilters(WsValidationFilter, WsAuthFilter)
@WebSocketGateway({
  namespace: 'games/search',
  cors: { origin: '*', credentials: true },
})
export class GameSearchGateway extends AuthenticatedGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  protected readonly logger = new Logger(GameSearchGateway.name);
  private readonly userQueryMap = wrapDefaults<WeakMap<Socket, WsClientData>, WsClientData>({
    wrap: new WeakMap(),
    defaultValue: (): WsClientData => ({
      activeSearches: new Map<string, Subscription>(),
    }),
    execute: true,
    setUndefined: true,
  });

  constructor(
    private readonly coordinator: GatewayCoordinatorClientService,
    override readonly authService: AuthService,
    private readonly db: DatabaseService,
  ) {
    super(authService);
  }

  handleDisconnect(client: Socket): void {
    this.cancelAllSearches(client);
    this.logger.log(`WS disconnected: socketId=${client.id}`);
  }

  @UsePipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
      validationError: {
        target: false,
        value: false,
      },
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  )
  @SubscribeMessage(SearchEvents.SearchStart)
  async handleSearchStart(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchStartDto): Promise<void> {
    this.logger.log(
      `Search start: socketId=${client.id} correlationId=${dto.correlationId} query="${
        dto.query
      }" gateways=[${dto.gatewayIds?.join(',')}]`,
    );

    if (!dto.includeLocal && !dto.includeExternal) {
      return this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
        correlationId: dto.correlationId,
        source: 'local',
        message: 'At least one of includeLocal or includeExternal must be true',
      });
    }

    if (this.getClientData(client).activeSearches.has(dto.correlationId)) {
      return this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
        correlationId: dto.correlationId,
        source: 'local',
        message: `Search with correlationId ${dto.correlationId} is already active`,
      });
    }

    await client.join(dto.correlationId);

    // TODO: return observables and merge -- error killing one source shouldn't kill the whole search
    await Promise.all([this.runLocalSearch(dto), this.runGatewaySearch(client, dto)]).finally(() => {
      this.completeSearch(client, dto.correlationId);
    });
  }

  private completeSearch(client: Socket, correlationId: string): void {
    const search = this.getClientData(client);
    search.activeSearches.delete(correlationId);
    client.leave(correlationId);
    this.logger.debug(`Search completed: correlationId=${correlationId}`);
  }

  @UsePipes(new ValidationPipe({ whitelist: true }))
  @SubscribeMessage(SearchEvents.SearchCancel)
  handleSearchCancel(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchCancelDto): void {
    const search = this.getClientData(client);
    const sub = search.activeSearches.get(dto.correlationId);

    if (!sub) {
      return this.logger.debug(`No active search to cancel: correlationId=${dto.correlationId}`);
    }

    sub?.unsubscribe();
    search.activeSearches.delete(dto.correlationId);
    client.leave(dto.correlationId);
    this.logger.log(`Search cancelled: correlationId=${dto.correlationId}`);
  }

  private async runLocalSearch(options: SearchStartDto) {
    if (options.includeLocal === false) {
      return Promise.resolve();
    }

    const source = 'local';

    try {
      const games = await this.db.game.findMany({
        where: {
          deletedAt: null,
          title: { contains: options.query, mode: 'insensitive' },
        },

        take: options.limit ?? 20,
        skip: options.offset ?? 0,

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
          },
        },
      });

      const results: WsGameSearchResult[] = games.map((g) => ({
        externalId: g.id,
        title: g.title,
        contentType: g.contentType,
        yearPublished: g.publishYear ?? undefined,
        thumbnailUrl: g.thumbnail || undefined,
        sourceUrl: g.gameSources?.[0]?.sourceUrl || undefined,
        averageRating: g.averageRating ?? undefined,
        minPlayers: g.minPlayers ?? undefined,
        maxPlayers: g.maxPlayers ?? undefined,
        inSystem: true,
        gameId: g.id,

        platforms: g.platformGames?.map((pg) => ({
          externalId: pg.platform.id,
          name: pg.platform.name,
          abbreviation: pg.platform.abbreviation ?? undefined,
          platformType: pg.platform.platformType.toString(),
        })),

        availableReleases: g.platformGames?.flatMap((pg) =>
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
              iso6393: l.language.code,
              iso6391: l.language.abbreviation ?? undefined,
              name: l.language.name,
            })),
          })),
        ),
      }));

      this.emit<WsSearchResultPayload>(options.correlationId, SearchEvents.SearchResult, {
        correlationId: options.correlationId,
        source,
        games: results,
      });
    } catch (err) {
      this.logger.error(`Local search failed for correlationId=${options.correlationId}`, err);
      this.emit<WsSearchErrorPayload>(options.correlationId, SearchEvents.SearchError, {
        correlationId: options.correlationId,
        message: 'Local search failed',
        source,
      });
    } finally {
      this.emit<WsSourceDonePayload>(options.correlationId, SearchEvents.SearchSourceDone, {
        correlationId: options.correlationId,
        source,
      });
    }
  }

  private runGatewaySearch(client: Socket, dto: SearchStartDto): Promise<void> {
    if (dto.includeExternal === false) {
      return Promise.resolve();
    }

    const search = this.getClientData(client);

    return new Promise<void>((resolve) => {
      const stream$ = this.coordinator.searchGames({
        correlationId: dto.correlationId,
        query: dto.query,
        gatewayIds: dto.gatewayIds || [],
        limit: dto.limit,
        offset: dto.offset,
        locale: dto.locale,
      });

      const sub = stream$.subscribe({
        next: (result) => {
          const source = result.gatewayId;

          this.logger.debug(
            `Received search result: correlationId=${dto.correlationId} source=${source} status=${result.status}`,
          );

          switch (result.status) {
            case ResultStatus.RESULT_STATUS_RESULT: {
              if (!result.game) {
                break;
              }

              const game: WsGameSearchResult = {
                externalId: result.game.externalId,
                title: result.game.title,
                contentType: result.game.contentType.toString(),
                yearPublished: result.game.yearPublished,
                thumbnailUrl: result.game.thumbnailUrl,
                sourceUrl: result.game.sourceUrl,
                averageRating: result.game.averageRating,
                minPlayers: result.game.minPlayers,
                maxPlayers: result.game.maxPlayers,
                baseGameExternalId: result.game.baseGameExternalId,
                inSystem: result.inSystem ?? false,
                gameId: result.gameId,

                platforms: (result.game.availablePlatforms ?? []).map((p) => ({
                  externalId: p.externalId,
                  name: p.name,
                  abbreviation: p.abbreviation,
                  platformType: p.platformType.toString(),
                })),

                availableReleases: (result.game.availableReleases ?? []).map((r) => ({
                  externalId: r.externalId,
                  platform: {
                    ...r.platform!,
                  },
                  status: r.status.toString(),
                  releaseDate: r.releaseDate,
                  languages: (r.languages ?? []).map((l) => ({
                    iso6393: l.iso6393,
                    iso6391: l.iso6391,
                    name: l.name,
                  })),
                })),
              };

              this.emit<WsSearchResultPayload>(dto.correlationId, SearchEvents.SearchResult, {
                correlationId: dto.correlationId,
                source,
                games: [game],
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_SOURCE_DONE: {
              this.emit<WsSourceDonePayload>(dto.correlationId, SearchEvents.SearchSourceDone, {
                correlationId: dto.correlationId,
                source,
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_RATE_LIMITED: {
              this.emit<WsRateLimitedPayload>(dto.correlationId, SearchEvents.SearchRateLimited, {
                correlationId: dto.correlationId,
                source,
                retryAfter: result.retryAfter ?? 60,
                message: result.message ?? 'Rate limited — please try again shortly',
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_UNAVAILABLE: {
              this.emit<WsSourceUnavailablePayload>(dto.correlationId, SearchEvents.SearchUnavailable, {
                correlationId: dto.correlationId,
                source,
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_ERROR: {
              this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
                correlationId: dto.correlationId,
                source,
                message: result.message ?? 'Search error',
              });
              break;
            }
          }
        },

        complete: () => {
          this.emit<WsSearchDonePayload>(dto.correlationId, SearchEvents.SearchDone, {
            correlationId: dto.correlationId,
          });
          resolve();
        },

        error: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Gateway search stream error: correlationId=${dto.correlationId}: ${message}`);
          this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
            correlationId: dto.correlationId,
            source: 'coordinator',
            message,
          });
          resolve();
        },
      });

      search.activeSearches.set(dto.correlationId, sub);
    });
  }

  private getClientData(client: Socket): WsClientData {
    return this.userQueryMap.get(client) as WsClientData;
  }

  private cancelAllSearches(client: Socket): void {
    const data = this.userQueryMap.get(client) as WsClientData | undefined;
    if (!data) return;

    for (const [correlationId, sub] of data.activeSearches) {
      sub.unsubscribe();
      client.leave(correlationId);
    }
    data.activeSearches.clear();
  }

  private emit<T>(correlationId: string, event: string, payload: T): void {
    this.server.to(correlationId).emit(event, payload);
  }
}
