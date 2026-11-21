import { DataGatewayCapability } from '@bge/database';
import { relayDriverAnswer } from '@bge/gateway-host';
import {
  GatewayRegistryService,
  GatewayRoutingRefusedError,
  refusalStatusCode,
  refusalTrailers,
} from '@bge/gateway-registry';
import { BGE_GATEWAY_ID_HEADER } from '@bge/shared';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type * as proto from '@boardgamesempire/proto-gateway';
import { GatewayServiceControllerMethods } from '@boardgamesempire/proto-gateway';
import type { Metadata } from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import { Controller } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { catchError, defer, mergeMap, throwError } from 'rxjs';

/** The DataGateway a call names in its metadata, or undefined when it names none. */
function gatewayIdNamedBy(metadata: Metadata | undefined): string | undefined {
  const [named] = metadata?.get(BGE_GATEWAY_ID_HEADER) ?? [];

  return typeof named === 'string' && named !== '' ? named : undefined;
}

/**
 * The gateway registry's refusal as the status the call answers with. A
 * DataGateway the registry doesn't know isn't there to whoever names it. Any
 * other refusal is of one that exists and may not serve the call as things
 * stand, which trying again won't change. The refusal's message says which,
 * and its trailers say it to the gateway worker, which reads it back as a
 * refusal and counts it toward no auto-disable.
 */
const refusalStatus = (refusal: GatewayRoutingRefusedError): RpcException =>
  new RpcException({
    code: refusalStatusCode(refusal),
    message: refusal.message,
    metadata: refusalTrailers(refusal),
  });

/**
 * The gateway gRPC protocol, served by the process that hosts the server's
 * data-gateway plugins (#1083). A remote DataGateway's app serves the
 * protocol for its one driver. This serves it for every plugin DataGateway
 * at once, so each call names its DataGateway in its metadata, under
 * `BGE_GATEWAY_ID_HEADER`, and is answered by that plugin's driver. The
 * gateway worker reaches a plugin DataGateway this way: it loads no plugin
 * itself, since a plugin runs as one copy.
 *
 * Each call makes the gateway registry's routing decision first, for the
 * capability its operation needs: `pluginDriver` refuses a DataGateway that
 * is disabled, whose plugin isn't served or loaded, or that doesn't declare
 * the capability, and refuses a remote DataGateway as unknown. Ping, Check
 * and Describe need no capability, and are refused only for a DataGateway
 * that may not be used at all. A refusal answers NOT_FOUND or
 * FAILED_PRECONDITION with its reason in the trailers ({@link refusalStatus}),
 * and a call that names no
 * DataGateway answers INVALID_ARGUMENT. Any other failure is relayed as a
 * remote DataGateway's app relays it, so a driver's own gRPC status, such as
 * UNIMPLEMENTED, reaches the gateway worker unchanged.
 *
 * The handlers take the call's metadata as Nest's gRPC server passes it,
 * after the request. It is optional in each signature because the generated
 * `GatewayServiceController` declares handlers of the request alone, and a
 * handler that required more would not implement it. A call with no
 * metadata names no DataGateway.
 *
 * It disposes no driver: the gateway registry owns each one it hands out,
 * and disposes them at shutdown.
 */
@GatewayServiceControllerMethods()
@Controller()
export class PluginGatewayController implements proto.GatewayServiceController {
  constructor(private readonly registry: GatewayRegistryService) {}

  ping(request: proto.GatewayPingRequest, metadata?: Metadata): Observable<proto.GatewayPingResponse> {
    return this.answer(metadata, undefined, (driver) => driver.ping(request));
  }

  check(request: proto.HealthCheckRequest, metadata?: Metadata): Observable<proto.HealthCheckResponse> {
    return this.answer(metadata, undefined, (driver) => driver.check(request));
  }

  describe(request: proto.DescribeRequest, metadata?: Metadata): Observable<proto.DescribeResponse> {
    return this.answer(metadata, undefined, (driver) => driver.describe(request));
  }

  searchGames(request: proto.GatewaySearchRequest, metadata?: Metadata): Observable<proto.GatewaySearchResult> {
    return this.answer(metadata, DataGatewayCapability.Search, (driver) => driver.searchGames(request));
  }

  fetchGame(request: proto.FetchGameRequest, metadata?: Metadata): Observable<proto.FetchGameResponse> {
    return this.answer(metadata, DataGatewayCapability.Fetch, (driver) => driver.fetchGame(request));
  }

  fetchGames(request: proto.FetchGamesRequest, metadata?: Metadata): Observable<proto.FetchGamesResponse> {
    return this.answer(metadata, DataGatewayCapability.FetchGames, (driver) => driver.fetchGames(request));
  }

  fetchExpansions(request: proto.FetchExpansionsRequest, metadata?: Metadata): Observable<proto.GatewaySearchResult> {
    return this.answer(metadata, DataGatewayCapability.FetchExpansions, (driver) => driver.fetchExpansions(request));
  }

  listLanguages(request: proto.ListLanguagesRequest, metadata?: Metadata): Observable<proto.ListLanguagesResponse> {
    return this.answer(metadata, DataGatewayCapability.ListLanguages, (driver) => driver.listLanguages(request));
  }

  listPlatforms(request: proto.ListPlatformsRequest, metadata?: Metadata): Observable<proto.ListPlatformsResponse> {
    return this.answer(metadata, DataGatewayCapability.ListPlatforms, (driver) => driver.listPlatforms(request));
  }

  listCategories(request: proto.ListCategoriesRequest, metadata?: Metadata): Observable<proto.ListCategoriesResponse> {
    return this.answer(metadata, DataGatewayCapability.ListCategories, (driver) => driver.listCategories(request));
  }

  listMechanics(request: proto.ListMechanicsRequest, metadata?: Metadata): Observable<proto.ListMechanicsResponse> {
    return this.answer(metadata, DataGatewayCapability.ListMechanics, (driver) => driver.listMechanics(request));
  }

  findUpstreamAccount(
    request: proto.FindUpstreamAccountRequest,
    metadata?: Metadata,
  ): Observable<proto.FindUpstreamAccountResponse> {
    return this.answer(metadata, DataGatewayCapability.FindUpstreamAccount, (driver) =>
      driver.findUpstreamAccount(request),
    );
  }

  /**
   * The answer of `call`, made on the driver of the plugin DataGateway the
   * metadata names, once the gateway registry routes it for `capability`.
   */
  private answer<T>(
    metadata: Metadata | undefined,
    capability: DataGatewayCapability | undefined,
    call: (driver: DataGatewayDriver) => Observable<T>,
  ): Observable<T> {
    const gatewayId = gatewayIdNamedBy(metadata);

    if (gatewayId === undefined) {
      return throwError(
        () =>
          new RpcException({
            code: status.INVALID_ARGUMENT,
            message: `The call names no DataGateway: its metadata needs '${BGE_GATEWAY_ID_HEADER}'`,
          }),
      );
    }

    const driver = defer(() => this.registry.pluginDriver(gatewayId, capability)).pipe(
      catchError((err: unknown) =>
        throwError(() => (err instanceof GatewayRoutingRefusedError ? refusalStatus(err) : err)),
      ),
    );

    return relayDriverAnswer(driver.pipe(mergeMap(call)));
  }
}
