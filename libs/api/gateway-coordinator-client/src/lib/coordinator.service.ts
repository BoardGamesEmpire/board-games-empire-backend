import {
  ConnectGatewayRequest,
  ConnectGatewayResponse,
  CoordinatorFetchExpansionsRequest,
  CoordinatorFetchGameRequest,
  CoordinatorFetchGameResponse,
  CoordinatorServiceClient,
  DisconnectGatewayRequest,
  DisconnectGatewayResponse,
  PingResponse,
  SearchGameResult,
  SearchGamesRequest,
} from '@board-games-empire/proto-gateway';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import * as crypto from 'node:crypto';
import { interval, Observable, Subscription } from 'rxjs';
import { map, mergeMap, tap } from 'rxjs/operators';
import { COORDINATOR_SERVICE_TOKEN } from './constants';

@Injectable()
export class GatewayCoordinatorClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayCoordinatorClientService.name);
  private coordinatorService!: CoordinatorServiceClient;
  private pingSubscription!: Subscription;

  constructor(
    @Inject(COORDINATOR_SERVICE_TOKEN)
    private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.coordinatorService = this.client.getService<CoordinatorServiceClient>('CoordinatorService');

    // TODO: more robust health check with retries and backoff
    const PING_INTERVAL_MS = 1000 * 60;
    this.pingSubscription = interval(PING_INTERVAL_MS)
      .pipe(
        map(() => crypto.randomUUID()),
        tap((correlationId) => this.logger.debug(`Pinging coordinator with correlationId=${correlationId}`)),
        mergeMap((correlationId) => this.ping(correlationId)),
      )
      .subscribe({
        next: (response) => this.logger.log('Coordinator ping:', response),
        error: (err) => this.logger.error('Coordinator ping error:', err),
      });
  }

  onModuleDestroy(): void {
    this.pingSubscription?.unsubscribe();
  }

  ping(correlationId?: string): Observable<PingResponse> {
    return this.coordinatorService.ping({ correlationId });
  }

  connectGateway(request: ConnectGatewayRequest): Observable<ConnectGatewayResponse> {
    return this.coordinatorService.connectGateway(request);
  }

  disconnectGateway(request: DisconnectGatewayRequest): Observable<DisconnectGatewayResponse> {
    return this.coordinatorService.disconnectGateway(request);
  }

  searchGames(request: SearchGamesRequest): Observable<SearchGameResult> {
    return this.coordinatorService.searchGames(request);
  }

  fetchGame(request: CoordinatorFetchGameRequest): Observable<CoordinatorFetchGameResponse> {
    return this.coordinatorService.fetchGame(request);
  }

  fetchExpansions(request: CoordinatorFetchExpansionsRequest): Observable<SearchGameResult> {
    return this.coordinatorService.fetchExpansions(request);
  }
}
