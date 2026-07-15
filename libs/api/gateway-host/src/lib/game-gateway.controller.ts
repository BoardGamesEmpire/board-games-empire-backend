import type * as proto from '@boardgamesempire/proto-gateway';
import { GatewayServiceControllerMethods } from '@boardgamesempire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { GatewayServiceHost } from './gateway-service.host';

/**
 * Shared gRPC controller for every gateway microservice. Logs each RPC
 * and delegates to the injected {@link GatewayServiceHost}; all
 * provider-specific behavior lives in the bound service.
 */
@GatewayServiceControllerMethods()
@Controller()
export class GameGatewayController implements proto.GatewayServiceController {
  private readonly logger = new Logger(GameGatewayController.name);

  constructor(private readonly gatewayService: GatewayServiceHost) {}

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    this.logger.log('Ping request received');

    return this.gatewayService.ping(request);
  }

  check(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    return this.gatewayService.healthCheck(request);
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`SearchGames request received with query: '${request.query}'`);
    return this.gatewayService.searchGames(request);
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    this.logger.log(`FetchGame request received for externalId: '${request.externalId}'`);
    return this.gatewayService.fetchGame(request);
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`FetchExpansions request received for baseExternalId: '${request.baseExternalId}'`);
    return this.gatewayService.fetchExpansions(request);
  }

  listLanguages(request: proto.ListLanguagesRequest): proto.ListLanguagesResponse {
    this.logger.log('ListLanguages request received');
    return this.gatewayService.listLanguages(request);
  }
}
