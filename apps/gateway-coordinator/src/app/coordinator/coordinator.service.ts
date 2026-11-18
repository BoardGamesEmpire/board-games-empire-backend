import { AuthType, Prisma } from '@bge/database';
import { GatewayRegistryService, GatewayRoutingRefusedError } from '@bge/gateway-registry';
import * as proto from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { z } from 'zod';

/**
 * The shape the registry stores a DataGateway's auth parameters in. The api
 * sends them as JSON text, so valid JSON that isn't an object (a number,
 * null, an array) is refused here rather than stored (#1322).
 */
const authParametersSchema = z.record(z.string(), z.unknown());

/**
 * Parses the api's auth parameters. Invalid JSON throws its own SyntaxError,
 * and JSON that isn't an object throws a plain error; the caller answers
 * either one as a failed connect (#1322).
 */
function parseAuthParameters(authParametersJson: string): Record<string, unknown> {
  const parsed = authParametersSchema.safeParse(JSON.parse(authParametersJson));

  if (!parsed.success) {
    throw new Error('authParametersJson must be a JSON object');
  }

  return parsed.data;
}

/**
 * The registry's reason when it refused the DataGateway, for the api to tell
 * the admin which fix applies (#1083). Any other failure carries none.
 */
function refusalReasonOf(error: unknown): { refusalReason?: string } {
  return error instanceof GatewayRoutingRefusedError ? { refusalReason: error.reason } : {};
}

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: GatewayRegistryService,
  ) {}

  async connectGateway(request: proto.ConnectGatewayRequest): Promise<proto.ConnectGatewayResponse> {
    const authType = Object.values(AuthType).find((each) => each === request.authType);

    if (authType === undefined) {
      return { success: false, error: `Unknown auth type: '${request.authType}'` };
    }

    try {
      const authParameters = request.authParametersJson ? parseAuthParameters(request.authParametersJson) : undefined;

      await this.registry.connect({
        gatewayId: request.gatewayId,
        connectionUrl: request.connectionUrl,
        connectionPort: request.connectionPort,
        authType,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse yields only JSON values, which the schema's z.unknown() doesn't carry into the type (#1321)
        authParameters: authParameters as Prisma.JsonValue,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ConnectGateway failed for ${request.gatewayId}: ${message}`);
      return { success: false, error: message, ...refusalReasonOf(error) };
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
   * Interviews a DataGateway now, for an admin who asks (#715). The registry
   * refuses one that's unknown, deleted, disabled, or a plugin DataGateway
   * whose plugin isn't served or loaded, before any interview runs. An
   * interview that runs and fails is recorded on the row. Either way the
   * error goes back for the api to log, and a refusal's reason with it
   * (#1083).
   */
  async reinterviewGateway(request: proto.ReinterviewGatewayRequest): Promise<proto.ReinterviewGatewayResponse> {
    try {
      await this.registry.reinterview(request.gatewayId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ReinterviewGateway failed for ${request.gatewayId}: ${message}`);
      return { success: false, error: message, ...refusalReasonOf(error) };
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
