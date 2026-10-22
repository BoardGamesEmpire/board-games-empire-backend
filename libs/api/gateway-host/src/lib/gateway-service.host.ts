import type * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { throwError, type Observable } from 'rxjs';

/** What a DataGateway answers for a call it doesn't serve. */
const unimplemented = <T>(rpc: string): Observable<T> =>
  throwError(
    () => new RpcException({ code: status.UNIMPLEMENTED, message: `${rpc} is not served by this DataGateway` }),
  );

/**
 * The provider-agnostic contract a gateway app fulfils so it can be
 * hosted by the shared {@link DataGatewayController}.
 *
 * Each gateway app's `DataGatewayService` extends this and is bound to
 * the token (`{ provide: GatewayServiceHost, useClass: DataGatewayService }`).
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

  abstract describe(request: proto.DescribeRequest): proto.DescribeResponse;

  abstract searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult>;

  abstract fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse>;

  abstract fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult>;

  abstract listLanguages(request: proto.ListLanguagesRequest): proto.ListLanguagesResponse;

  // A DataGateway declares only the lists it serves, and the server asks for
  // no other (#711, #718). So these answer UNIMPLEMENTED unless overridden,
  // and a DataGateway that serves none needs no code for them.

  listPlatforms(_request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    return unimplemented('ListPlatforms');
  }

  listCategories(_request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    return unimplemented('ListCategories');
  }

  listMechanics(_request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    return unimplemented('ListMechanics');
  }
}
