import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts —
// `./app/lib/logger` initializes OTel, so it must precede the
// `@bge/gateway-host` import below (which pulls in @nestjs/core + the gRPC
// stack that the auto-instrumentations hook).
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { bootstrapGrpcMicroservice } from '@bge/gateway-host';
import * as path from 'node:path';
import { AppModule } from './app/app.module';

void bootstrapGrpcMicroservice({
  appModule: AppModule,
  displayName: 'BoardgamesEmpire Gateway Coordinator',
  hostEnv: 'COORDINATOR_GRPC_HOST',
  portEnv: 'COORDINATOR_GRPC_PORT',
  protoPackage: 'bge.coordinator.v1',
  // The shared proto tree also carries the gateway package — the coordinator
  // serves only its own.
  protoExclude: [/(^|[/\\])gateway([/\\]|$)/],
  protoDir: path.join(__dirname, 'proto'),
  bootstrapLogger,
  // Coordinator is OTel-instrumented: sequence app.close() → otel.shutdown().
  registerShutdown: (app) => registerShutdownHandlers(app, otel, bootstrapLogger),
  onBootstrapError: () => void otel.shutdown().finally(() => process.exit(1)),
});
