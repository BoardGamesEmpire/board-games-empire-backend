import {
  GatewayPingRequest,
  GatewayPingResponse,
  HealthCheckRequest,
  HealthCheckResponse,
  HealthCheckResponse_ServingStatus,
} from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  ping(request: GatewayPingRequest): GatewayPingResponse {
    return {
      correlationId: request?.correlationId || crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayVersion: '1.0.0',
      gatewayName: 'BoardGameGeekGateway',
      supportedServices: ['GatewayService', 'ProfileSync'],
    };
  }

  healthCheck(request: HealthCheckRequest): HealthCheckResponse {
    this.logger.log(`Health check request received for service: ${request.service}`);

    return {
      status: HealthCheckResponse_ServingStatus.SERVING,
    };
  }
}
