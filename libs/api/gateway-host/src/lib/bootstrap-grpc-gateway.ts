import { registerLoggerShutdown } from '@bge/logger';
import { PROTO_PACKAGE_NAME } from '@boardgamesempire/proto-gateway';
import type { Type } from '@nestjs/common';
import { bootstrapGrpcMicroservice } from './bootstrap-grpc-microservice';
import type { GatewayLoggers } from './gateway-logger';

/** Proto walk skips the coordinator package — gateways serve only their own. */
const COORDINATOR_PROTO_EXCLUSION = /(^|[/\\])coordinator([/\\]|$)/;

export interface GrpcGatewayBootstrapConfig {
  /** The gateway app's root Nest module. */
  readonly appModule: Type<unknown>;

  /**
   * Human-readable name for the startup banner,
   * e.g. `'BoardgamesEmpire BoardgameGeek Gateway'`.
   */
  readonly displayName: string;

  /**
   * Env key holding the gRPC bind host, e.g. `'BOARDGAMEGEEK_GATEWAY_GRPC_HOST'`.
   */
  readonly hostEnv: string;

  /**
   * Env key holding the gRPC bind port, e.g. `'BOARDGAMEGEEK_GATEWAY_GRPC_PORT'`.
   */
  readonly portEnv: string;

  /**
   * Absolute directory the app's `.proto` assets are copied into at build.
   * Pass `path.join(__dirname, 'proto')` from the app's `main.ts` so
   * `__dirname` resolves against the app's own bundle, not this library.
   */
  readonly protoDir: string;

  /**
   * The `bootstrap`-tagged child logger from {@link createGatewayLogger},
   * shared with the app's `LoggerModule` so pre-Nest and shutdown lines
   * flow through the same transport.
   */
  readonly bootstrapLogger: GatewayLoggers['bootstrapLogger'];
}

/**
 * Boots a gateway gRPC microservice by specializing the shared
 * {@link bootstrapGrpcMicroservice} primitive: the gateway proto package, the
 * coordinator-package exclusion, and pino-only shutdown (gateways deliberately
 * run without OTel — see the shutdown note on the config). Every gateway app
 * shares this one call instead of carrying a near-identical `bootstrap()`.
 */
export function bootstrapGrpcGateway(config: GrpcGatewayBootstrapConfig): Promise<void> {
  const { appModule, displayName, hostEnv, portEnv, protoDir, bootstrapLogger } = config;

  return bootstrapGrpcMicroservice({
    appModule,
    displayName,
    hostEnv,
    portEnv,
    protoDir,
    protoPackage: PROTO_PACKAGE_NAME,
    protoExclude: [COORDINATOR_PROTO_EXCLUSION],
    bootstrapLogger,
    registerShutdown: (app) => registerLoggerShutdown(app, bootstrapLogger),
    onBootstrapError: () => bootstrapLogger.flush(() => process.exit(1)),
  });
}
