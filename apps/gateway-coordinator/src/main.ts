import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts.
import { env } from '@bge/env';
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { walkDir } from '@bge/utils';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { Logger as PinoLogger } from 'nestjs-pino';
import * as path from 'node:path';
import { AppModule } from './app/app.module';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  bootstrapLogger.debug(`Bootstrapping BoardgamesEmpire Gateway Coordinator in ${env.currentEnv} mode`);

  const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])gateway([/\\]|$)/]);
  bootstrapLogger.info({ protoPaths }, 'loading gRPC proto files');

  const url = `${env.provide('COORDINATOR_GRPC_HOST')}:${env.provide('COORDINATOR_GRPC_PORT')}`;

  const app: INestMicroservice = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    bufferLogs: true,
    options: {
      url,
      package: 'bge.coordinator.v1',
      protoPath: protoPaths,
      loader: {
        includeDirs: [path.join(__dirname, 'proto')],
        arrays: true,
        longs: String,
        enums: String,
      },
    },
  });

  app.useLogger(app.get(PinoLogger));

  // `enableShutdownHooks()` is intentionally omitted — manual signal
  // handlers below sequence `app.close()` before `otel.shutdown()`.
  registerShutdownHandlers(app, otel, bootstrapLogger);

  await app.listen();
  bootstrapLogger.info({ url }, '🚀 application is running on grpc');
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'coordinator bootstrap failed');
  void otel.shutdown().finally(() => process.exit(1));
});
