import type * as proto from '@board-games-empire/proto-gateway';
import { CoordinatorServiceController, CoordinatorServiceControllerMethods } from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';

@CoordinatorServiceControllerMethods()
@Controller()
export class CoordinatorController implements CoordinatorServiceController {
  private readonly logger = new Logger(CoordinatorController.name);

  constructor(
    private readonly coordinatorService: CoordinatorService,
    private readonly gameSearchService: GameSearchService,
  ) {}

  ping(request: proto.PingRequest): proto.PingResponse {
    this.logger.log('Ping request received');
    return this.coordinatorService.ping(request);
  }

  check(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    return this.coordinatorService.healthCheck(request);
  }

  connectGateway(request: proto.ConnectGatewayRequest): Promise<proto.ConnectGatewayResponse> {
    return this.coordinatorService.connectGateway(request);
  }

  disconnectGateway(request: proto.DisconnectGatewayRequest): proto.DisconnectGatewayResponse {
    return this.coordinatorService.disconnectGateway(request);
  }

  searchGames(request: proto.SearchGamesRequest): Observable<proto.SearchGameResult> {
    return this.gameSearchService.searchGames(request);
  }

  fetchGame(request: proto.CoordinatorFetchGameRequest): Observable<proto.CoordinatorFetchGameResponse> {
    return this.gameSearchService.fetchGame(request);
  }

  fetchExpansions(request: proto.CoordinatorFetchExpansionsRequest): Observable<proto.SearchGameResult> {
    return this.gameSearchService.fetchExpansions(request);
  }
}
