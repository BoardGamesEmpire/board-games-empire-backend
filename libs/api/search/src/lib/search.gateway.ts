import { type AuthType, AUTH_INSTANCE } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { DatabaseService } from '@bge/database';
import { ResultStatus } from '@board-games-empire/proto-gateway';
import { Inject, Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
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
import { SearchEvents } from './constants';
import type {
  WsGameSearchResult,
  WsRateLimitedPayload,
  WsSearchDonePayload,
  WsSearchErrorPayload,
  WsSearchResultPayload,
  WsSourceDonePayload,
  WsSourceUnavailablePayload,
} from './dto/search-outbound.dto';
import { SearchCancelDto, SearchStartDto } from './dto/search-start.dto';

interface WsClientData {
  // userId: string;
  /** correlationId → active gRPC stream subscription */
  activeSearches: Map<string, Subscription>;
}

@UseGuards(AuthGuard)
@WebSocketGateway({
  namespace: 'games/search',
  cors: { origin: '*', credentials: true },
})
export class SearchGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(SearchGateway.name);
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
    private readonly db: DatabaseService,
    @Inject(AUTH_INSTANCE) private readonly auth: AuthType,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake?.auth?.token;
    this.logger.log(`WS connection attempt: socketId=${client.id} token=${token ? 'present' : 'absent'}`);

    if (!token) {
      this.logger.warn(`Unauthorized WS connection attempt: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    // TODO: helper service in auth module to validate WS tokens and fetch session info, instead of
    // calling the full auth API here or injecting auth context
    const session = await this.auth.api.getSession({
      headers: new Headers({
        Authorization: `Bearer ${token}`,
      }),
    });

    if (!session?.user) {
      this.logger.warn(`Invalid session for WS connection: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    if (session.session.expiresAt < new Date()) {
      this.logger.warn(`Expired session for WS connection: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    this.logger.log(`WS connected: socketId=${client.id}`);
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
        limit: dto.limit ?? undefined,
        offset: dto.offset ?? undefined,
      });

      const sub = stream$.subscribe({
        next: (result) => {
          const source = result.gatewayId;

          switch (result.status) {
            case ResultStatus.RESULT_STATUS_RESULT: {
              if (!result.game) {
                break;
              }

              const game: WsGameSearchResult = {
                externalId: result.game.externalId,
                title: result.game.title,
                contentType: result.game.contentType.toString(),
                yearPublished: result.game.yearPublished ?? undefined,
                thumbnailUrl: result.game.thumbnailUrl ?? undefined,
                sourceUrl: result.game.sourceUrl ?? undefined,
                averageRating: result.game.averageRating ?? undefined,
                minPlayers: result.game.minPlayers ?? undefined,
                maxPlayers: result.game.maxPlayers ?? undefined,
                baseGameExternalId: result.game.baseGameExternalId ?? undefined,
                inSystem: result.inSystem ?? false,
                gameId: result.gameId ?? undefined,
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
