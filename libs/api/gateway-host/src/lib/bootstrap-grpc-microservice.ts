import { env } from '@bge/env';
import { walkDir } from '@bge/utils';
import type { INestMicroservice, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import type { Logger as PinoLogger } from 'pino';

export interface GrpcMicroserviceBootstrapConfig {
  /** The service's root Nest module. */
  readonly appModule: Type<unknown>;

  /** Human-readable name for the startup banner. */
  readonly displayName: string;

  /** Env key holding the gRPC bind host. */
  readonly hostEnv: string;

  /** Env key holding the gRPC bind port. */
  readonly portEnv: string;

  /**
   * gRPC package declared in the served protos, e.g. `PROTO_PACKAGE_NAME`
   * (gateways) or `'bge.coordinator.v1'` (coordinator).
   */
  readonly protoPackage: string;

  /**
   * Absolute directory the service's `.proto` assets are copied into at build.
   * Pass `path.join(__dirname, 'proto')` from the app's `main.ts` so `__dirname`
   * resolves against the app's own bundle, not this library.
   */
  readonly protoDir: string;

  /**
   * Path patterns skipped while walking {@link protoDir} — used where a shared
   * proto tree also carries a sibling service's protos (a gateway excludes the
   * coordinator package; the coordinator excludes the gateway package).
   */
  readonly protoExclude?: readonly RegExp[];

  /**
   * The `bootstrap`-tagged child logger, shared with the app's `LoggerModule`
   * so pre-Nest and shutdown lines flow through the same transport.
   */
  readonly bootstrapLogger: PinoLogger;

  /**
   * Installs the flush-then-exit signal handlers. Each host passes its own so
   * the difference is explicit and intentional: OTel-instrumented services
   * (coordinator) flush spans via `@bge/otel`'s `registerShutdownHandlers`,
   * while the plain gateway hosts — which deliberately run without OTel — just
   * flush pino via `@bge/logger`'s `registerLoggerShutdown`.
   */
  readonly registerShutdown: (app: INestMicroservice) => void;

  /**
   * Bootstrap-failure handler. The error is already logged; this only performs
   * the host-specific flush/shutdown before `process.exit(1)` (pino flush for
   * gateways, `otel.shutdown()` for the coordinator).
   */
  readonly onBootstrapError: (error: unknown) => void;
}

/**
 * Boots a gRPC microservice: walks the proto assets, creates the microservice,
 * installs the pino logger, wires the (host-supplied) shutdown handlers, and
 * listens. Owns its failure path (log, then delegate flush/exit to
 * {@link GrpcMicroserviceBootstrapConfig.onBootstrapError}), so each app's
 * `main.ts` is a single declarative call.
 *
 * The one gRPC bootstrap for the whole workspace. `bootstrapGrpcGateway`
 * specializes it for the gateway hosts; the gateway-coordinator app calls it
 * directly. The only differences between callers — proto package, proto
 * exclusion, and shutdown strategy (OTel vs pino-only) — are parameters, so the
 * proto-walk / createMicroservice / listen mechanics live in exactly one place.
 */
export async function bootstrapGrpcMicroservice(config: GrpcMicroserviceBootstrapConfig): Promise<void> {
  const {
    appModule,
    displayName,
    hostEnv,
    portEnv,
    protoPackage,
    protoDir,
    protoExclude = [],
    bootstrapLogger,
    registerShutdown,
    onBootstrapError,
  } = config;

  try {
    if (!env.isProduction) {
      Error.stackTraceLimit = Infinity;
    }

    bootstrapLogger.debug(`Bootstrapping ${displayName} in ${env.currentEnv} mode`);

    const protoPaths = walkDir(protoDir, /\.proto$/, [...protoExclude]);
    bootstrapLogger.info({ protoPaths }, 'loading gRPC proto files');

    const url = `${env.provide(hostEnv)}:${env.provide(portEnv)}`;

    const app = await NestFactory.createMicroservice(appModule, {
      transport: Transport.GRPC,
      // Buffer module-init logs until `useLogger` is called below, so they flow
      // through nestjs-pino rather than Nest's default ConsoleLogger to stdout.
      bufferLogs: true,
      options: {
        url,
        package: protoPackage,
        protoPath: protoPaths,
        loader: {
          includeDirs: [protoDir],
          arrays: true,
          longs: String,
          enums: String,
        },
      },
    });

    app.useLogger(app.get(Logger));

    // `enableShutdownHooks()` is intentionally omitted — the handlers wired
    // here sequence `app.close()` before flushing (and, where applicable,
    // shutting OTel down) so the trailing batch of records is not dropped.
    registerShutdown(app);

    await app.listen();
    bootstrapLogger.info({ url }, '🚀 application is running on grpc');
  } catch (error) {
    bootstrapLogger.error({ err: error }, 'bootstrap failed');
    onBootstrapError(error);
  }
}
