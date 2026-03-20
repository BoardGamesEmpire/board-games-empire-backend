import type * as proto from '@board-games-empire/proto-gateway';
import { GatewayServiceControllerMethods } from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { GameGatewayService } from './game-gateway.service';

@GatewayServiceControllerMethods()
@Controller()
export class GameGatewayController implements proto.GatewayServiceController {
  private readonly logger = new Logger(GameGatewayController.name);

  constructor(private readonly gameGatewayService: GameGatewayService) {}

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    this.logger.log('Ping request received');

    return this.gameGatewayService.ping(request);
  }

  check(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    return this.gameGatewayService.healthCheck(request);
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`SearchGames request received with query: '${request.query}'`);
    return this.gameGatewayService.searchGames(request);
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    this.logger.log(`FetchGame request received for externalId: '${request.externalId}'`);
    return this.gameGatewayService.fetchGame(request);
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`FetchExpansions request received for baseExternalId: '${request.baseExternalId}'`);
    return this.gameGatewayService.fetchExpansions(request);
  }
}
