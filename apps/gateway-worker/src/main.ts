// OpenTelemetry SDK MUST be initialised before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts.
import { env } from '@bge/env';
import { registerShutdownHandlers } from '@bge/otel';
import 'reflect-metadata';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { GatewayWorkerModule } from './app/gateway-worker.module';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  const app = await NestFactory.createApplicationContext(GatewayWorkerModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(PinoLogger));

  // `enableShutdownHooks()` is intentionally omitted — manual signal
  // handlers below sequence `app.close()` before `otel.shutdown()`.
  registerShutdownHandlers(app, otel, bootstrapLogger);

  bootstrapLogger.info('🛰️  gateway worker process started — awaiting BullMQ jobs');
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'gateway worker bootstrap failed');
  void otel.shutdown().finally(() => process.exit(1));
});
