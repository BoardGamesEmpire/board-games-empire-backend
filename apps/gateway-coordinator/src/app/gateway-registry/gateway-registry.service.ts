import { pingWithRetry, walkDir } from '@bge/utils';
import { GatewayServiceClient, PROTO_PACKAGE_NAME } from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ClientGrpcProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { GatewayConnectionOptions } from '../interfaces';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';

@Injectable()
export class GatewayRegistryService {
  private readonly logger = new Logger(GatewayRegistryService.name);
  private readonly registry = new Map<string, ClientGrpcProxy>();

  constructor(private readonly credentialsFactory: GatewayCredentialsFactory) {}

  async connect(options: GatewayConnectionOptions): Promise<void> {
    const url = `${options.connectionUrl}:${options.connectionPort}`;

    if (this.registry.has(options.gatewayId)) {
      this.logger.log(`Replacing existing connection for gateway ${options.gatewayId}`);
      this.disconnect(options.gatewayId);
    }

    this.logger.log(`Connecting to gateway ${options.gatewayId} at ${url} with auth type ${options.authType}`);
    const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])coordinator([/\\]|$)/]);

    const channelCredentials = this.credentialsFactory.create(options.authType, options.authParameters);
    const client = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        url,
        package: PROTO_PACKAGE_NAME,
        protoPath: protoPaths,
        loader: {
          includeDirs: [path.join(__dirname, 'proto')],
          arrays: true,
          longs: String,
          enums: String,
        },
        credentials: channelCredentials,
      },
    });

    const gatewayServiceClient = client.getService<GatewayServiceClient>('GatewayService');
    const response = await pingWithRetry(gatewayServiceClient, options.gatewayId, this.logger);

    this.logger.log(
      `Successfully connected to gateway ${options.gatewayId} at ${url}. Response: ${JSON.stringify(response)}`,
    );

    // TODO: schedule health checks and auto-disconnect if unhealthy
    this.registry.set(options.gatewayId, client);
    this.logger.log(`Gateway ${options.gatewayId} connected at ${url}`);
  }

  disconnect(gatewayId: string): void {
    const client = this.registry.get(gatewayId);

    if (!client) {
      return this.logger.warn(`Attempted to disconnect gateway ${gatewayId} but no connection exists`);
    }

    client.close();
    this.registry.delete(gatewayId);
    this.logger.log(`Gateway ${gatewayId} disconnected`);
  }

  get(gatewayId: string): ClientGrpcProxy {
    const client = this.registry.get(gatewayId);

    if (!client) {
      throw new Error(`No connection found for gateway ${gatewayId}. Ensure it is enabled and connected.`);
    }

    return client;
  }

  getServiceClient(gatewayId: string): GatewayServiceClient {
    return this.get(gatewayId).getService<GatewayServiceClient>('GatewayService');
  }

  isConnected(gatewayId: string): boolean {
    return this.registry.has(gatewayId);
  }

  connectedGatewayIds(): string[] {
    return Array.from(this.registry.keys());
  }
}
