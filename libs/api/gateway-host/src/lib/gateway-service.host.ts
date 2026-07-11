import type * as proto from '@boardgamesempire/proto-gateway';
import type { Observable } from 'rxjs';

/**
 * The provider-agnostic contract a gateway app fulfils so it can be
 * hosted by the shared {@link GameGatewayController}.
 *
 * Each gateway app's `GameGatewayService` implements this and is bound to
 * the token (`{ provide: GatewayServiceHost, useClass: GameGatewayService }`).
 * The controller depends only on this abstraction, so the gRPC host layer
 * is identical across every gateway (BoardGameGeek, IGDB, …) while the
 * search/fetch logic stays provider-specific.
 *
 * Method names mirror the concrete services (`healthCheck`, not the proto
 * RPC name `check`); the controller maps proto RPCs onto them.
 */
export abstract class GatewayServiceHost {
  abstract ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse;

  abstract healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse;

  abstract searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult>;

  abstract fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse>;

  abstract fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult>;
}
