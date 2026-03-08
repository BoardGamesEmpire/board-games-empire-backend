import { CoordinatorServiceClient, PingResponse } from '@board-games-empire/proto-gateway';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { interval, mergeMap, Observable } from 'rxjs';
import { COORDINATOR_SERVICE_TOKEN } from './constants';

@Injectable()
export class GatewayCoordinatorClientService implements OnModuleInit {
  private coordinatorService!: CoordinatorServiceClient;

  constructor(
    @Inject(COORDINATOR_SERVICE_TOKEN)
    private readonly client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.coordinatorService = this.client.getService<CoordinatorServiceClient>('CoordinatorService');

    // TODO: Implement a more robust health check mechanism, possibly with retries and backoff strategy.
    const PING_INTERVAL = 1000 * 60; // 1 minute
    interval(PING_INTERVAL)
      .pipe(mergeMap(() => this.ping()))
      .subscribe({
        next: (response) => {
          console.log('Ping response:', response);
        },
        error: (err) => {
          console.error('Ping error:', err);
        },
      });
  }

  ping(correlationId?: string): Observable<PingResponse> {
    return this.coordinatorService.ping({ correlationId });
  }
}
