import * as proto from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  ping(request: proto.GatewayPingRequest): proto.GatewayPingResponse {
    return {
      correlationId: request?.correlationId || crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      gatewayVersion: '1.0.0',
      gatewayName: 'IGDBGateway',
      // TODO: placeholders - replace with actual supported services
      supportedServices: ['GatewayService', 'ProfileSync'],
    };
  }

  healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    this.logger.log(`Health check request received for service: ${request.service}`);

    return {
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    };
  }
}
