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
import { t } from '@bge/i18n';
import { AbilityService, CheckPolicies } from '@bge/permissions';
import { ResultStatus } from '@boardgamesempire/proto-gateway';
import { BadRequestException, ConflictException, Logger, UsePipes } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { wrapDefaults } from '@status/defaults';
import { I18nValidationPipe } from 'nestjs-i18n';
import { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '../base/authenticated.gateway';
import { WsFrameScope } from '../base/ws-frame-scope';
import { WsTranslator } from '../base/ws-translator';

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
    frameScope: WsFrameScope,
    translator: WsTranslator,
  ) {
    super(authService, frameScope, translator);
  }

  handleDisconnect(client: Socket): void {
    this.cancelAllSearches(client);
    this.logger.log(`WS disconnected: socketId=${client.id}`);
  }

  // I18nValidationPipe, so a decorator's catalog marker reaches WsErrorFilter
  // to be translated (#180). No nestjs-i18n context exists on a frame, so the
  // pipe leaves the markers for the filter rather than translating them.
  @UsePipes(
    new I18nValidationPipe({
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
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @SubscribeMessage(SearchEvents.SearchStart)
  async handleSearchStart(@ConnectedSocket() client: Socket, @MessageBody() dto: SearchStartDto): Promise<void> {
    this.logger.log(
      `Search start: socketId=${client.id} correlationId=${dto.correlationId} query="${
        dto.query
      }" gateways=[${dto.gatewayIds?.join(',')}]`,
    );

    // Both refusals are thrown for WsErrorFilter to answer on the socket
    // itself: a first-time id has no room joined yet, and a repeated id's room
    // belongs to the search already running (#426).
    if (!dto.includeLocal && !dto.includeExternal) {
      throw new BadRequestException(t('errors.game_search.no_source_selected'));
    }

    const { activeSearches } = this.getClientData(client);
    if (activeSearches.has(dto.correlationId)) {
      throw new ConflictException(t('errors.game_search.already_active', { correlationId: dto.correlationId }));
    }

    // Registered before the first await and for the whole search, local half
    // included, so the check above refuses a second search with this id
    // however the first was asked for. The gateway half adds its stream to it.
    const search = new Subscription();
    activeSearches.set(dto.correlationId, search);

    await client.join(this.searchRoom(client, dto.correlationId));

    // TODO: return observables and merge -- error killing one source shouldn't kill the whole search
    try {
      await Promise.all([this.runLocalSearch(client, dto, search), this.runGatewaySearch(client, dto, search)]);
    } finally {
      this.completeSearch(client, dto.correlationId, search);
    }
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

  @UsePipes(new I18nValidationPipe({ whitelist: true }))
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

  private async runLocalSearch(client: Socket, options: SearchStartDto, search: Subscription) {
    if (options.includeLocal === false) {
      return Promise.resolve();
    }

    const source = 'local';

    // A cancel stops the coordinator stream but cannot stop a query already in
    // flight, and by the time it answers the id may belong to a new search in
    // the same room. So a cancelled search sends nothing more.
    const emit = <T>(event: string, payload: T): void => {
      if (!search.closed) {
        this.emit<T>(client, options.correlationId, event, payload);
      }
    };

    try {
      const readConditions = this.abilityService.getCurrentResourceConditions(ResourceType.Game, Action.read);
      const results = await this.gameSearch.queryLocalGames(
        options.query,
        readConditions,
        options.limit,
        options.offset,
      );

      emit<WsSearchResultPayload>(SearchEvents.SearchResult, {
        correlationId: options.correlationId,
        source,
        games: results,
      });
    } catch (err) {
      this.logger.error(`Local search failed for correlationId=${options.correlationId}`, err);
      emit<WsSearchErrorPayload>(SearchEvents.SearchError, {
        correlationId: options.correlationId,
        message: this.translator.forClient(client, t('errors.game_search.local_failed')),
        source,
      });
    } finally {
      emit<WsSourceDonePayload>(SearchEvents.SearchSourceDone, {
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
                message: result.message ?? this.translator.forClient(client, t('errors.game_search.rate_limited')),
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
                message: result.message ?? this.translator.forClient(client, t('errors.game_search.source_error')),
              });
              break;
            }
          }
        },

        complete: () => resolve(),

        // The error's own text is written for operators (for an unreachable
        // coordinator, it names the address), so it is only logged, and the
        // client is told the external half failed, as the local half does
        // (#519).
        error: (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.error(`Gateway search stream error: correlationId=${dto.correlationId}: ${detail}`);
          this.emit<WsSearchErrorPayload>(client, dto.correlationId, SearchEvents.SearchError, {
            correlationId: dto.correlationId,
            source: 'coordinator',
            message: this.translator.forClient(client, t('errors.game_search.external_failed')),
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

  /**
   * Sends a search frame to its room from this node only. The socket is
   * always connected here, and the cluster adapter delivers a broadcast only
   * after publishing it to Redis, by which time `completeSearch` has left the
   * room, so a search that finishes quickly would arrive empty.
   * Connection-state recovery replays none of these frames, and a search could
   * not resume from them anyway: a disconnect cancels every search.
   */
  private emit<T>(client: Socket, correlationId: string, event: string, payload: T): void {
    this.server.to(this.searchRoom(client, correlationId)).local.emit(event, payload);
  }
}
