import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type {
  FetchExpansionsRequest,
  FetchGameRequest,
  FetchGameResponse,
  GatewayPingRequest,
  GatewayPingResponse,
  GatewaySearchRequest,
  GatewaySearchResult,
  GatewayServiceClient,
  HealthCheckRequest,
  HealthCheckResponse,
  ListLanguagesRequest,
  ListLanguagesResponse,
} from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import type { ClientGrpcProxy } from '@nestjs/microservices';
import type { Observable } from 'rxjs';

/**
 * The remote transport adapter for {@link GameGatewayDriver} (#193, D1):
 * wraps a verified gRPC channel to an external gateway service and exposes
 * the port by delegating to the ts-proto client.
 *
 * Construction goes through `RemoteGatewayDriverFactory`, which owns proto
 * loading, credentials, and the ping-verified handshake — a driver instance
 * only exists once its channel answered a ping. Lifecycle (caching, lazy
 * connect, invalidation races, failure tracking) stays in
 * `GatewayRegistryService`; this class holds nothing but the live channel.
 *
 * Note on signatures: delegation forwards the request only. The ts-proto
 * client accepts optional gRPC metadata, but no BGE call site supplies it —
 * if that changes, widen the delegation rather than bypassing the port.
 */
export class RemoteGatewayDriver implements GameGatewayDriver {
  private readonly logger = new Logger(RemoteGatewayDriver.name);

  constructor(
    readonly gatewayId: string,
    private readonly proxy: ClientGrpcProxy,
    private readonly client: GatewayServiceClient,
  ) {}

  ping(request: GatewayPingRequest): Observable<GatewayPingResponse> {
    return this.client.ping(request);
  }

  check(request: HealthCheckRequest): Observable<HealthCheckResponse> {
    return this.client.check(request);
  }

  searchGames(request: GatewaySearchRequest): Observable<GatewaySearchResult> {
    return this.client.searchGames(request);
  }

  fetchGame(request: FetchGameRequest): Observable<FetchGameResponse> {
    return this.client.fetchGame(request);
  }

  fetchExpansions(request: FetchExpansionsRequest): Observable<GatewaySearchResult> {
    return this.client.fetchExpansions(request);
  }

  listLanguages(request: ListLanguagesRequest): Observable<ListLanguagesResponse> {
    return this.client.listLanguages(request);
  }

  /**
   * Best-effort channel teardown — never throws, just logs a close failure.
   * Safe to call repeatedly (grpc-js tolerates closing a closed channel).
   */
  dispose(): void {
    try {
      this.proxy.close();
    } catch (err) {
      this.logger.warn(`Error closing client for ${this.gatewayId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
