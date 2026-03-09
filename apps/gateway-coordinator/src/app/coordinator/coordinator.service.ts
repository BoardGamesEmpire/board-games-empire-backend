import { AuthType, Prisma } from '@bge/database';
import {
  ConnectGatewayRequest,
  ConnectGatewayResponse,
  DisconnectGatewayRequest,
  DisconnectGatewayResponse,
  HealthCheckRequest,
  HealthCheckResponse,
  HealthCheckResponse_ServingStatus,
  PingRequest,
  PingResponse,
} from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { GatewayRegistryService } from '../gateway-registry/gateway-registry.service';

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(private readonly configService: ConfigService, private readonly registry: GatewayRegistryService) {}

  async connectGateway(request: ConnectGatewayRequest): Promise<ConnectGatewayResponse> {
    const authType = request.authType as AuthType;

    if (!Object.values(AuthType).includes(authType)) {
      return { success: false, error: `Unknown auth type: '${request.authType}'` };
    }

    try {
      const authParameters = request.authParametersJson
        ? (JSON.parse(request.authParametersJson) as Record<string, unknown>)
        : undefined;

      await this.registry.connect({
        gatewayId: request.gatewayId,
        connectionUrl: request.connectionUrl,
        connectionPort: request.connectionPort,
        authType,
        authParameters: authParameters as Prisma.JsonValue,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ConnectGateway failed for ${request.gatewayId}: ${message}`);
      return { success: false, error: message };
    }
  }

  disconnectGateway(request: DisconnectGatewayRequest): DisconnectGatewayResponse {
    try {
      this.registry.disconnect(request.gatewayId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`DisconnectGateway failed for ${request.gatewayId}: ${message}`);
      return { success: false, error: message };
    }
  }

  ping(request: PingRequest): PingResponse {
    return {
      correlationId: request?.correlationId || crypto.randomUUID(),
      timestampMs: Date.now(),
      coordinatorVersion: this.configService.get<string>('coordinator.version') || 'unknown',
    };
  }

  healthCheck(request: HealthCheckRequest): HealthCheckResponse {
    this.logger.log(`Health check request received for service: ${request.service}`);

    return {
      status: HealthCheckResponse_ServingStatus.SERVING,
    };
  }
}
