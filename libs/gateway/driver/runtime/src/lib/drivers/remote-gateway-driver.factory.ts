import { pingWithRetry, walkDir } from '@bge/utils';
import { GatewayServiceClient, PROTO_PACKAGE_NAME } from '@boardgamesempire/proto-gateway';
import type { ClientOptions, Interceptor } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import { ClientGrpcProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { GatewayCredentialsFactory } from '../credentials/gateway-credentials.factory';
import type { GatewayConnectionOptions } from '../interfaces';
import { RemoteGatewayDriver } from './remote-gateway.driver';

/**
 * Builds ping-verified {@link RemoteGatewayDriver} instances from gateway
 * connection config. Owns everything transport-shaped that used to live
 * inline in `GatewayRegistryService.connect()`: proto path discovery,
 * ChannelCredentials selection, proxy construction, and the connect-time
 * ping handshake.
 *
 * Injectable so specs stub `create()` and never touch gRPC — the registry's
 * race guards are tested against this seam.
 */
@Injectable()
export class RemoteGatewayDriverFactory {
  private readonly logger = new Logger(RemoteGatewayDriverFactory.name);

  constructor(private readonly credentialsFactory: GatewayCredentialsFactory) {}

  /**
   * Establishes and verifies a connection, returning a live driver. Throws
   * when the ping handshake fails — the caller (registry) feeds that into
   * connection-failure tracking. The freshly-built channel is closed before
   * the failure propagates so an unverified proxy never leaks.
   *
   * `channel` is for a driver whose calls must carry metadata: the gateway
   * worker's plugin driver source dials the coordinator, which refuses a call
   * that names no DataGateway or no actor (#1083). Its interceptors run, in
   * the order given, on every call the client makes, so on the ping here too.
   */
  async create(
    options: GatewayConnectionOptions,
    channel?: { interceptors?: Interceptor[] },
  ): Promise<RemoteGatewayDriver> {
    const url = `${options.connectionUrl}:${options.connectionPort}`;

    this.logger.log(`Connecting to gateway ${options.gatewayId} at ${url} with auth type ${options.authType}`);

    // The gateway proto tree ships alongside the compiled bundle; the shared
    // tree also carries the coordinator package, which gateways don't serve.
    const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])coordinator([/\\]|$)/]);

    const channelCredentials = this.credentialsFactory.create(options.authType, options.authParameters);
    const proxy = ClientProxyFactory.create({
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
        // NestJS spreads `channelOptions` into the options of the grpc-js
        // Client it constructs, and those take an `interceptors` array, which
        // is what `satisfies` checks here. Left out when no interceptors are
        // given, so a remote DataGateway's client is built with no channel
        // options at all.
        ...(channel?.interceptors && {
          channelOptions: { interceptors: channel.interceptors } satisfies ClientOptions,
        }),
      },
    }) as ClientGrpcProxy;

    const client = proxy.getService<GatewayServiceClient>('GatewayService');

    try {
      const response = await pingWithRetry(client, options.gatewayId, this.logger);

      this.logger.log(
        `Successfully connected to gateway ${options.gatewayId} at ${url}. Response: ${JSON.stringify(response)}`,
      );
    } catch (err) {
      // Previously the failed channel was abandoned open; close it before the
      // failure propagates into the registry's connection-failure tracking.
      try {
        proxy.close();
      } catch (closeErr) {
        this.logger.warn(
          `Error closing unverified client for ${options.gatewayId}: ${
            closeErr instanceof Error ? closeErr.message : closeErr
          }`,
        );
      }
      throw err;
    }

    return new RemoteGatewayDriver(options.gatewayId, proxy, client);
  }
}
