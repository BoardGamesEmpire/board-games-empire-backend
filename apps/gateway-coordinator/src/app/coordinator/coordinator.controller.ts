import type { HealthCheckRequest, PingRequest } from '@board-games-empire/proto-gateway';
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

  ping(request: PingRequest): PingResponse {
    this.logger.log('Ping request received');
    return this.coordinatorService.ping(request);
  }

  health(
    request: HealthCheckRequest,
  ): Promise<HealthCheckResponse> | Observable<HealthCheckResponse> | HealthCheckResponse {
    return this.coordinatorService.healthCheck(request);
  }
}
