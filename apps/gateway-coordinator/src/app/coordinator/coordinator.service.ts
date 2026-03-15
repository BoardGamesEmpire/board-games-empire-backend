import { AuthType, Prisma } from '@bge/database';
import * as proto from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { GatewayRegistryService } from '../gateway-registry/gateway-registry.service';

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(private readonly configService: ConfigService, private readonly registry: GatewayRegistryService) {}

  async connectGateway(request: proto.ConnectGatewayRequest): Promise<proto.ConnectGatewayResponse> {
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

  disconnectGateway(request: proto.DisconnectGatewayRequest): proto.DisconnectGatewayResponse {
    try {
      this.registry.disconnect(request.gatewayId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`DisconnectGateway failed for ${request.gatewayId}: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Basic ping handler for quick connectivity verification from the main application.
   *
   * @todo ping gateways on a schedule and track their health status, so we can return more accurate
   * info here and proactively disconnect unhealthy gateways.
   */
  ping(request: proto.PingRequest): proto.PingResponse {
    return {
      correlationId: request?.correlationId || crypto.randomUUID(),
      timestampMs: BigInt(Date.now()),
      coordinatorVersion: this.configService.get<string>('coordinator.version', 'unknown'),
    };
  }

  healthCheck(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    this.logger.log(`Health check request received for service: ${request.service}`);
    return {
      status: proto.HealthCheckResponse_ServingStatus.SERVING,
    };
  }
}
