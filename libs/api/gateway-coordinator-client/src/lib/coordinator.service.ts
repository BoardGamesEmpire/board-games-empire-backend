import {
  ConnectGatewayRequest,
  ConnectGatewayResponse,
  CoordinatorServiceClient,
  DisconnectGatewayRequest,
  DisconnectGatewayResponse,
  PingResponse,
} from '@board-games-empire/proto-gateway';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import * as crypto from 'node:crypto';
import { interval, mergeMap, Observable, Subscription } from 'rxjs';
import { COORDINATOR_SERVICE_TOKEN } from './constants';

@Injectable()
export class GatewayCoordinatorClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayCoordinatorClientService.name);
  private coordinatorService!: CoordinatorServiceClient;
  private subscription!: Subscription;

  constructor(
    @Inject(COORDINATOR_SERVICE_TOKEN)
    private readonly client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.coordinatorService = this.client.getService<CoordinatorServiceClient>('CoordinatorService');

    // TODO: Implement a more robust health check mechanism, possibly with retries and backoff strategy.
    const PING_INTERVAL = 1000 * 60; // 1 minute
    this.subscription = interval(PING_INTERVAL)
      .pipe(mergeMap(() => this.ping(crypto.randomUUID())))
      .subscribe({
        next: (response) => {
          this.logger.log('Ping response:', response);
        },
        error: (err) => {
          this.logger.error('Ping error:', err);
        },
      });
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
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
}
