import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { DatabaseService } from '@bge/database';
import { ResultStatus } from '@board-games-empire/proto-gateway';
import { Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
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

/** Per-socket metadata stored on client.data */
interface WsClientData {
  userId: string;
  email: string;
  /** correlationId → active gRPC stream subscription */
  activeSearches: Map<string, Subscription>;
}

@UseGuards(AuthGuard)
@WebSocketGateway({
  namespace: 'games-search',
  cors: { origin: '*', credentials: true },
})
export class SearchGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(SearchGateway.name);

  constructor(private readonly coordinator: GatewayCoordinatorClientService, private readonly db: DatabaseService) {}

  async handleConnection(@Session() session: UserSession, client: Socket): Promise<void> {
    this.logger.log(`WS connected: userId=${session.user.id} socketId=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.cancelAllSearches(client);
    this.logger.log(`WS disconnected: socketId=${client.id}`);
  }

  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  @SubscribeMessage(SearchEvents.SearchStart)
  async handleSearchStart(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchStartDto): Promise<void> {
    const data = this.getClientData(client);
    if (data.activeSearches.has(dto.correlationId)) {
      throw new WsException(`Search with correlationId ${dto.correlationId} is already active`);
    }

    await client.join(dto.correlationId);

    await Promise.all([
      dto.includeLocal !== false ? this.runLocalSearch(dto) : Promise.resolve(),
      this.runGatewaySearch(client, dto),
    ]);
  }

  @UsePipes(new ValidationPipe({ whitelist: true }))
  @SubscribeMessage(SearchEvents.SearchCancel)
  handleSearchCancel(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchCancelDto): void {
    const data = this.getClientData(client);
    const sub = data.activeSearches.get(dto.correlationId);

    sub?.unsubscribe();
    data.activeSearches.delete(dto.correlationId);
    client.leave(dto.correlationId);
    this.logger.log(`Search cancelled: correlationId=${dto.correlationId}`);
  }

  private async runLocalSearch(dto: SearchStartDto): Promise<void> {
    const { correlationId, query, limit, offset } = dto;

    try {
      const games = await this.db.game.findMany({
        where: {
          deletedAt: null,
          title: { contains: query, mode: 'insensitive' },
        },
        take: limit ?? 20,
        skip: offset ?? 0,
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

      this.emit<WsSearchResultPayload>(correlationId, SearchEvents.SearchResult, {
        correlationId,
        source: 'local',
        games: results,
      });
    } catch (err) {
      this.logger.error(`Local search failed for correlationId=${correlationId}`, err);
      this.emit<WsSearchErrorPayload>(correlationId, SearchEvents.SearchError, {
        correlationId,
        source: 'local',
        message: 'Local search failed',
      });
    } finally {
      this.emit<WsSourceDonePayload>(correlationId, SearchEvents.SearchSourceDone, {
        correlationId,
        source: 'local',
      });
    }
  }

  private runGatewaySearch(client: Socket, dto: SearchStartDto): Promise<void> {
    if (dto.gatewayIds.length === 0) {
      return Promise.resolve();
    }

    const data = this.getClientData(client);
    return new Promise<void>((resolve) => {
      const stream$ = this.coordinator.searchGames({
        correlationId: dto.correlationId,
        query: dto.query,
        gatewayIds: dto.gatewayIds,
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

            case ResultStatus.RESULT_STATUS_SOURCE_DONE:
              this.emit<WsSourceDonePayload>(dto.correlationId, SearchEvents.SearchSourceDone, {
                correlationId: dto.correlationId,
                source,
              });
              break;

            case ResultStatus.RESULT_STATUS_RATE_LIMITED:
              this.emit<WsRateLimitedPayload>(dto.correlationId, SearchEvents.SearchRateLimited, {
                correlationId: dto.correlationId,
                source,
                retryAfter: result.retryAfter ?? 60,
                message: result.message ?? 'Rate limited — please try again shortly',
              });
              break;

            case ResultStatus.RESULT_STATUS_UNAVAILABLE:
              this.emit<WsSourceUnavailablePayload>(dto.correlationId, SearchEvents.SearchUnavailable, {
                correlationId: dto.correlationId,
                source,
              });
              break;

            case ResultStatus.RESULT_STATUS_ERROR:
              this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
                correlationId: dto.correlationId,
                source,
                message: result.message ?? 'An error occurred',
              });
              break;
          }
        },

        error: (err) => {
          this.logger.error(`gRPC stream error for correlationId=${dto.correlationId}`, err);
          this.emit<WsSearchErrorPayload>(dto.correlationId, SearchEvents.SearchError, {
            correlationId: dto.correlationId,
            source: 'coordinator',
            message: 'Search stream failed',
          });
          data.activeSearches.delete(dto.correlationId);
          client.leave(dto.correlationId);
          resolve();
        },

        complete: () => {
          this.emit<WsSearchDonePayload>(dto.correlationId, SearchEvents.SearchDone, {
            correlationId: dto.correlationId,
          });
          data.activeSearches.delete(dto.correlationId);
          client.leave(dto.correlationId);
          resolve();
        },
      });

      data.activeSearches.set(dto.correlationId, sub);
    });
  }

  private emit<T>(room: string, event: string, payload: T): void {
    this.server.to(room).emit(event, payload);
  }

  private getClientData(client: Socket): WsClientData {
    return client.data as WsClientData;
  }

  private cancelAllSearches(client: Socket): void {
    const data = this.getClientData(client);
    if (!data?.activeSearches) return;

    for (const [correlationId, sub] of data.activeSearches) {
      sub.unsubscribe();
      this.logger.log(`Cancelled search on disconnect: correlationId=${correlationId}`);
    }

    data.activeSearches.clear();
  }
}
