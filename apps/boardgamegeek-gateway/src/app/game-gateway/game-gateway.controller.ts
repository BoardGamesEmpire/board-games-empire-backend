import {
  GatewayPingRequest,
  GatewayPingResponse,
  GatewayServiceController,
  GatewayServiceControllerMethods,
  HealthCheckRequest,
  HealthCheckResponse,
} from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
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
}
