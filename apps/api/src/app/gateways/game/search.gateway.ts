import { AuthService } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ResourceType } from '@bge/database';
import type {
  WsClientData,
  WsRateLimitedPayload,
  WsSearchDonePayload,
  WsSearchErrorPayload,
  WsSearchResultPayload,
  WsSourceDonePayload,
  WsSourceUnavailablePayload,
} from '@bge/game-search';
import { GameSearchService, SearchCancelDto, SearchEvents, SearchStartDto } from '@bge/game-search';
import { AbilityService } from '@bge/permissions';
import { ResultStatus } from '@boardgamesempire/proto-gateway';
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
  private readonly userQueryMap = wrapDefaults<WeakMap<Socket, WsClientData>, Pick<WsClientData, 'activeSearches'>>({
    wrap: new WeakMap(),
    defaultValue: (): Pick<WsClientData, 'activeSearches'> => ({
      activeSearches: new Map<string, Subscription>(),
    }),
    execute: true,
    setUndefined: true,
  });

  constructor(
    private readonly coordinator: GatewayCoordinatorClientService,
    override readonly authService: AuthService,
    private readonly gameSearch: GameSearchService,
    private readonly abilityService: AbilityService,
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
      return this.emit<WsSearchErrorPayload>(client, dto.correlationId, SearchEvents.SearchError, {
        correlationId: dto.correlationId,
        source: 'local',
        message: 'At least one of includeLocal or includeExternal must be true',
      });
    }

    const { activeSearches } = this.getClientData(client);
    if (activeSearches.has(dto.correlationId)) {
      return this.emit<WsSearchErrorPayload>(client, dto.correlationId, SearchEvents.SearchError, {
        correlationId: dto.correlationId,
        source: 'local',
        message: `Search with correlationId ${dto.correlationId} is already active`,
      });
    }

    // Registered before the first await and for the whole search, local half
    // included, so the check above refuses a second search with this id
    // however the first was asked for. The gateway half adds its stream to it.
    const search = new Subscription();
    activeSearches.set(dto.correlationId, search);

    await client.join(this.searchRoom(client, dto.correlationId));

    // TODO: return observables and merge -- error killing one source shouldn't kill the whole search
    await Promise.all([this.runLocalSearch(client, dto), this.runGatewaySearch(client, dto, search)]).finally(() => {
      this.completeSearch(client, dto.correlationId, search);
    });
  }

  /**
   * Ends a search once both halves have finished. `search:done` is its last
   * frame, sent only here so it never overtakes the local results. A search
   * no longer registered was cancelled — the cancel already left its room —
   * and the id may since belong to a new search, so neither is touched.
   */
  private completeSearch(client: Socket, correlationId: string, search: Subscription): void {
    const { activeSearches } = this.getClientData(client);
    if (activeSearches.get(correlationId) !== search) {
      return;
    }

    this.emit<WsSearchDonePayload>(client, correlationId, SearchEvents.SearchDone, { correlationId });
    activeSearches.delete(correlationId);
    client.leave(this.searchRoom(client, correlationId));
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
    client.leave(this.searchRoom(client, dto.correlationId));
    this.logger.log(`Search cancelled: correlationId=${dto.correlationId}`);
  }

  private async runLocalSearch(client: Socket, options: SearchStartDto) {
    if (options.includeLocal === false) {
      return Promise.resolve();
    }

    const source = 'local';

    try {
      // No ability context is primed for a WebSocket message the way HTTP
      // primes one per request (#498), so the actor the socket authenticated
      // as is resolved here. Per search rather than per connection: its grants
      // can change while the socket stays open. A failure lands in the catch
      // below as a SearchError, never as an unfiltered query.
      const abilities = await this.abilityService.resolveAbilitiesForActor(this.getClientData(client).actor);
      const readConditions = this.abilityService.getResourceConditionsForAbilities(
        abilities,
        ResourceType.Game,
        Action.read,
      );

      const results = await this.gameSearch.queryLocalGames(
        options.query,
        readConditions,
        options.limit,
        options.offset,
      );

      this.emit<WsSearchResultPayload>(client, options.correlationId, SearchEvents.SearchResult, {
        correlationId: options.correlationId,
        source,
        games: results,
      });
    } catch (err) {
      this.logger.error(`Local search failed for correlationId=${options.correlationId}`, err);
      this.emit<WsSearchErrorPayload>(client, options.correlationId, SearchEvents.SearchError, {
        correlationId: options.correlationId,
        message: 'Local search failed',
        source,
      });
    } finally {
      this.emit<WsSourceDonePayload>(client, options.correlationId, SearchEvents.SearchSourceDone, {
        correlationId: options.correlationId,
        source,
      });
    }
  }

  private runGatewaySearch(client: Socket, dto: SearchStartDto, search: Subscription): Promise<void> {
    if (dto.includeExternal === false) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      // A cancel stops the stream before it can complete or error, so the
      // cancel itself ends the wait.
      search.add(() => resolve());

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

              this.emit<WsSearchResultPayload>(client, dto.correlationId, SearchEvents.SearchResult, {
                correlationId: dto.correlationId,
                source,
                games: [this.gameSearch.mapProtoGame(result)],
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_SOURCE_DONE: {
              this.emit<WsSourceDonePayload>(client, dto.correlationId, SearchEvents.SearchSourceDone, {
                correlationId: dto.correlationId,
                source,
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_RATE_LIMITED: {
              this.emit<WsRateLimitedPayload>(client, dto.correlationId, SearchEvents.SearchRateLimited, {
                correlationId: dto.correlationId,
                source,
                retryAfter: result.retryAfter ?? 60,
                message: result.message ?? 'Rate limited — please try again shortly',
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_UNAVAILABLE: {
              this.emit<WsSourceUnavailablePayload>(client, dto.correlationId, SearchEvents.SearchUnavailable, {
                correlationId: dto.correlationId,
                source,
              });
              break;
            }

            case ResultStatus.RESULT_STATUS_ERROR: {
              this.emit<WsSearchErrorPayload>(client, dto.correlationId, SearchEvents.SearchError, {
                correlationId: dto.correlationId,
                source,
                message: result.message ?? 'Search error',
              });
              break;
            }
          }
        },

        complete: () => resolve(),

        error: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Gateway search stream error: correlationId=${dto.correlationId}: ${message}`);
          this.emit<WsSearchErrorPayload>(client, dto.correlationId, SearchEvents.SearchError, {
            correlationId: dto.correlationId,
            source: 'coordinator',
            message,
          });
          resolve();
        },
      });

      search.add(sub);
    });
  }

  private getClientData(client: Socket): WsClientData {
    const clientData = this.userQueryMap.get(client);
    return {
      ...client.data,
      ...clientData,
    } satisfies WsClientData;
  }

  private cancelAllSearches(client: Socket): void {
    const data = this.userQueryMap.get(client) as WsClientData | undefined;
    if (!data) return;

    for (const [correlationId, sub] of data.activeSearches) {
      sub.unsubscribe();
      client.leave(this.searchRoom(client, correlationId));
    }
    data.activeSearches.clear();
  }

  /**
   * The room a search's frames go to: the socket's own, per correlation id.
   * The id is the client's choice, and local results depend on who is asking
   * (#472), so a room keyed by the id alone would deliver one user's private
   * games to any other socket that sent the same id.
   */
  private searchRoom(client: Socket, correlationId: string): string {
    return `${client.id}:${correlationId}`;
  }

  private emit<T>(client: Socket, correlationId: string, event: string, payload: T): void {
    this.server.to(this.searchRoom(client, correlationId)).emit(event, payload);
  }
}
