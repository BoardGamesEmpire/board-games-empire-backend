import { env } from '@bge/env';
import { joinHostPort, walkDir } from '@bge/utils';
import type { INestMicroservice, Type } from '@nestjs/common';
import type { ConfigFactory, ConfigFactoryKeyHost } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport, type AsyncMicroserviceOptions, type GrpcOptions } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import type { Logger as PinoLogger } from 'pino';

/** Where a gRPC server listens. */
export interface GrpcListenAddress {
  readonly host: string;
  readonly port: number;
}

/** A `registerAs` config whose value includes the address a server listens on. */
export type GrpcAddressConfig = ConfigFactory<GrpcListenAddress> & Pick<ConfigFactoryKeyHost, 'KEY'>;

export interface GrpcMicroserviceBootstrapConfig {
  /** The service's root Nest module. */
  readonly appModule: Type<unknown>;

  /** Human-readable name for the startup banner. */
  readonly displayName: string;

  /**
   * The app's config for the address it listens on, such as a gateway's
   * `gatewayConfig`. It must be one the app's root module loads. The address
   * is read from it once that config is validated, so a variable that fails
   * validation is what the boot reports, and an address the environment
   * leaves unset takes the config's default (#636).
   */
  readonly addressConfig: GrpcAddressConfig;

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
   * Bootstrap-failure handler. When the bootstrap calls it, the error is
   * already logged and `process.exitCode` is already 1; this only performs the
   * host-specific flush/shutdown before `process.exit(1)` (pino flush for
   * gateways, `otel.shutdown()` for the coordinator). If that exit is never
   * reached, a process left with nothing to do still ends with code 1.
   */
  readonly onBootstrapError: (error: unknown) => void;
}

/**
 * Boots a gRPC microservice: walks the proto assets, creates the microservice,
 * installs the pino logger, wires the (host-supplied) shutdown handlers, and
 * listens. Owns its failure path (log, set exit code 1, then delegate
 * flush/exit to {@link GrpcMicroserviceBootstrapConfig.onBootstrapError}), so
 * each app's `main.ts` is a single declarative call. The exception is an error
 * thrown while Nest builds the app's modules and providers, such as a root
 * config that fails validation or a config factory reading a missing
 * variable: Nest prints it through its own `ExceptionHandler` and exits 1
 * itself, so it never reaches the catch below (#627). A root config is
 * validated as the app module is imported, though, and Nest sees that failure
 * only when this is called in the same tick, as the gateways call it. The
 * coordinator awaits `runBootstrap` first, so Node reports the failure as an
 * unhandled rejection instead: still exit 1 and the variable named, but as a
 * raw stack, with no `bootstrap failed` record.
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
    addressConfig,
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

    const app = await NestFactory.createMicroservice<AsyncMicroserviceOptions>(appModule, {
      // Buffer module-init logs until `useLogger` is called below, so they flow
      // through nestjs-pino rather than Nest's default ConsoleLogger to stdout.
      bufferLogs: true,
      // Resolved after the app's modules are, so the root config has been
      // validated by the time the address is read from it.
      inject: [addressConfig.KEY],
      useFactory: ({ host, port }: GrpcListenAddress): GrpcOptions => ({
        transport: Transport.GRPC,
        options: {
          url: joinHostPort(host, port),
          package: protoPackage,
          protoPath: protoPaths,
          loader: {
            includeDirs: [protoDir],
            arrays: true,
            longs: String,
            enums: String,
          },
        },
      }),
    });

    app.useLogger(app.get(Logger));

    // `enableShutdownHooks()` is intentionally omitted — the handlers wired
    // here sequence `app.close()` before flushing (and, where applicable,
    // shutting OTel down) so the trailing batch of records is not dropped.
    registerShutdown(app);

    await app.listen();
    const { host, port } = app.get<GrpcListenAddress>(addressConfig.KEY);
    bootstrapLogger.info({ url: joinHostPort(host, port) }, '🚀 application is running on grpc');
  } catch (error) {
    bootstrapLogger.error({ err: error }, 'bootstrap failed');
    // Set before the host's handler runs, which may never finish: a pino
    // transport's flush callback does not run once nothing else holds the
    // event loop, so a gateway's `exit(1)` inside it is never reached and the
    // process ends on its own, with this code (#630).
    process.exitCode = 1;
    onBootstrapError(error);
  }
}
