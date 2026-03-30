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

  override async handleConnection(client: Socket): Promise<void> {
    const session = await super.handleConnection(client);
    if (!session) {
      return;
    }

    client.data = {
      ...client.data,
      activeSearches: new Map<string, Subscription>(),
    } satisfies WsClientData;
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
      }" gateways=[${dto.gatewayIds.join(',')}]`,
    );

    if (this.getClientData(client).activeSearches.has(dto.correlationId)) {
      return this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
        correlationId: dto.correlationId,
        source: 'local',
        message: `Search with correlationId ${dto.correlationId} is already active`,
      });
    }

    await client.join(dto.correlationId);

    // TODO: return observables and merge -- error killing one source shouldn't kill the whole search
    await Promise.all([this.runLocalSearch(dto), this.runGatewaySearch(client, dto)]);
  }

  @UsePipes(new ValidationPipe({ whitelist: true }))
  @SubscribeMessage(SearchEvents.SearchCancel)
  handleSearchCancel(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchCancelDto): void {
    const search = this.getClientData(client);
    const sub = search.activeSearches.get(dto.correlationId);

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
              platform: {
                select: {
                  id: true,
                  name: true,
                  abbreviation: true,
                  platformType: true,
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
      });

      const results: WsGameSearchResult[] = games.map((g) => ({
        externalId: g.id,
        title: g.title,
        contentType: 'BASE_GAME',
        yearPublished: g.publishYear ?? undefined,
        thumbnailUrl: g.thumbnail || undefined,
        sourceUrl: g.gameSources[0]?.sourceUrl || undefined,
        averageRating: g.averageRating ?? undefined,
        minPlayers: g.minPlayers ?? undefined,
        maxPlayers: g.maxPlayers ?? undefined,
        inSystem: true,
        gameId: g.id,

        platforms: g.releases.map((r) => ({
          externalId: r.platform.id,
          name: r.platform.name,
          abbreviation: r.platform.abbreviation ?? undefined,
          platformType: r.platform.platformType.toString(),
        })),

        availableReleases: g.releases.map((r) => ({
          externalId: r.platform.id,
          platform: {
            externalId: r.platform.id,
            name: r.platform.name,
            abbreviation: r.platform.abbreviation ?? undefined,
            platformType: r.platform.platformType.toString(),
          },

          status: 'RELEASE_STATUS_RELEASED',
          releaseDate: r.releaseDate?.toISOString().split('T')[0] ?? undefined,
          languages: r.languages.map((l) => ({
            iso6393: l.language.code,
            iso6391: l.language.abbreviation ?? undefined,
            name: l.language.name,
          })),
        })),
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
        source,
        message: 'Local search failed',
      });
    } finally {
      this.emit<WsSourceDonePayload>(options.correlationId, SearchEvents.SearchSourceDone, {
        correlationId: options.correlationId,
        source,
      });
    }
  }

  private runGatewaySearch(client: Socket, dto: SearchStartDto): Promise<void> {
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
                message: result.message ?? 'An error occurred',
              });
              break;
            }
          }
        },

        error: (err) => {
          this.logger.error(`gRPC stream error for correlationId=${dto.correlationId}`, err);
          this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
            correlationId: dto.correlationId,
            source: 'coordinator',
            message: 'Search stream failed',
          });

          search.activeSearches.delete(dto.correlationId);
          client.leave(dto.correlationId);
          resolve();
        },

        complete: () => {
          this.logger.debug(`Search stream completed for correlationId=${dto.correlationId}`);

          this.emit<WsSearchDonePayload>(dto.correlationId, SearchEvents.SearchDone, {
            correlationId: dto.correlationId,
          });

          search.activeSearches.delete(dto.correlationId);
          client.leave(dto.correlationId);
          resolve();
        },
      });

      search.activeSearches.set(dto.correlationId, sub);
    });
  }

  private emit<T>(room: string, event: string, payload: T): void {
    this.server.to(room).emit(event, payload);
  }

  private getClientData(client: Socket): WsClientData {
    return this.userQueryMap.get(client);
  }

  private cancelAllSearches(client: Socket): void {
    const search = this.getClientData(client);
    for (const [correlationId, sub] of search.activeSearches) {
      sub.unsubscribe();
      this.logger.log(`Cancelled search on disconnect: correlationId=${correlationId}`);
    }

    search.activeSearches.clear();
  }
}
