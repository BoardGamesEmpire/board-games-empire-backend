import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts —
// `./app/lib/logger` initializes OTel, so it must precede the
// `@bge/gateway-host` import below (which pulls in @nestjs/core + the gRPC
// stack that the auto-instrumentations hook).
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { runBootstrap } from '@bge/bootstrap';
import { bootstrapGrpcMicroservice } from '@bge/gateway-host';
import { nestLoggerFromPino } from '@bge/logger';
import { PluginLoadRecorder } from '@bge/plugin';
import * as path from 'node:path';
import { AppModule } from './app/app.module';
import coordinatorConfig from './app/configuration/coordinator.config';
import { withdrawLoadRecordsBeforeClose } from './app/lib/withdraw-load-records-before-close';

const onBootstrapError = (): void => void otel.shutdown().finally(() => process.exit(1));

async function bootstrap(): Promise<void> {
  // No migrator here: the coordinator checks that the schema matches its build
  // and waits for the api to bring it up when it does not (#236).
  await runBootstrap({ applicationName: 'gateway-coordinator', logger: nestLoggerFromPino(bootstrapLogger) });

  await bootstrapGrpcMicroservice({
    appModule: AppModule,
    displayName: 'BoardgamesEmpire Gateway Coordinator',
    addressConfig: coordinatorConfig,
    // Its own package, which the api calls, and the gateway's, which the
    // gateway worker calls to reach the plugin DataGateways the coordinator
    // hosts (#1083). The shared proto tree carries both.
    protoPackage: ['bge.coordinator.v1', 'bge.gateway.v1'],
    protoDir: path.join(__dirname, 'proto'),
    bootstrapLogger,
    // Coordinator is OTel-instrumented: sequence app.close() → otel.shutdown().
    // Its plugin load records are withdrawn before app.close(), which stops
    // the gRPC server before the shutdown hooks run: a gateway worker then
    // refuses its plugin DataGateways instead of dialling a server that is
    // gone (#1083).
    registerShutdown: (app) => registerShutdownHandlers(withdrawLoadRecordsBeforeClose(app), otel, bootstrapLogger),
    // The same gap at startup: the plugins load in the bootstrap hooks, which
    // Nest runs before the gRPC server listens. Their load records say ready
    // only from here, so a gateway worker refuses a plugin DataGateway until
    // the coordinator answers, instead of dialling it and counting each
    // failure (#1083). It never rejects.
    afterListen: (app) => app.get(PluginLoadRecorder).markServing(),
    onBootstrapError,
  });
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'bootstrap failed');
  onBootstrapError();
});
