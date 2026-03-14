import {
  FetchExpansionsRequest,
  FetchGameRequest,
  FetchGameResponse,
  GatewayPingRequest,
  GatewayPingResponse,
  GatewaySearchRequest,
  GatewaySearchResult,
  GatewayServiceController,
  GatewayServiceControllerMethods,
  HealthCheckRequest,
  HealthCheckResponse,
} from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { GameGatewayService } from './game-gateway.service';

@GatewayServiceControllerMethods()
@Controller()
export class GameGatewayController implements GatewayServiceController {
  private readonly logger = new Logger(GameGatewayController.name);

  constructor(private readonly gameGatewayService: GameGatewayService) {}

  ping(request: GatewayPingRequest): GatewayPingResponse {
    this.logger.log('Ping request received');

    return this.gameGatewayService.ping(request);
  }

  check(request: HealthCheckRequest): HealthCheckResponse {
    return this.gameGatewayService.healthCheck(request);
  }

  searchGames(request: GatewaySearchRequest): Observable<GatewaySearchResult> {
    throw new Error('Method not implemented.');
  }

  fetchGame(request: FetchGameRequest): Promise<FetchGameResponse> | Observable<FetchGameResponse> | FetchGameResponse {
    throw new Error('Method not implemented.');
  }

  fetchExpansions(request: FetchExpansionsRequest): Observable<GatewaySearchResult> {
    throw new Error('Method not implemented.');
  }
}
