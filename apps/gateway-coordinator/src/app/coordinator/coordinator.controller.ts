import type {
  ConnectGatewayRequest,
  ConnectGatewayResponse,
  DisconnectGatewayRequest,
  DisconnectGatewayResponse,
  HealthCheckRequest,
  PingRequest,
} from '@board-games-empire/proto-gateway';
import {
  CoordinatorServiceController,
  CoordinatorServiceControllerMethods,
  HealthCheckResponse,
  PingResponse,
} from '@board-games-empire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CoordinatorService } from './coordinator.service';

@CoordinatorServiceControllerMethods()
@Controller()
export class CoordinatorController implements CoordinatorServiceController {
  private readonly logger: Logger = new Logger(CoordinatorController.name);

  constructor(private readonly coordinatorService: CoordinatorService) {}

  connectGateway(request: ConnectGatewayRequest): Promise<ConnectGatewayResponse> {
    return this.coordinatorService.connectGateway(request);
  }

  disconnectGateway(request: DisconnectGatewayRequest): DisconnectGatewayResponse {
    return this.coordinatorService.disconnectGateway(request);
  }

  ping(request: PingRequest): PingResponse {
    this.logger.log('Ping request received');
    return this.coordinatorService.ping(request);
  }

  check(
    request: HealthCheckRequest,
  ): Promise<HealthCheckResponse> | Observable<HealthCheckResponse> | HealthCheckResponse {
    return this.coordinatorService.healthCheck(request);
  }
}
