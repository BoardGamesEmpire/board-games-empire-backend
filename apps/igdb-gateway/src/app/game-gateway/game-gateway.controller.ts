import type * as proto from '@board-games-empire/proto-gateway';
import { GatewayServiceControllerMethods } from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
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
    throw new Error('Method not implemented.');
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    throw new Error('Method not implemented.');
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    throw new Error('Method not implemented.');
  }
}
