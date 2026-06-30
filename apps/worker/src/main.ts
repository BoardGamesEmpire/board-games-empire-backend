import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts.
import { env } from '@bge/env';
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { WorkerModule } from './app/worker.module';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  bootstrapLogger.debug(`Bootstrapping BoardgamesEmpire worker in ${env.currentEnv} mode`);

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(PinoLogger));

  // `enableShutdownHooks()` is intentionally omitted — manual signal
  // handlers below sequence `app.close()` before `otel.shutdown()`.
  registerShutdownHandlers(app, otel, bootstrapLogger);

  bootstrapLogger.info('🔧 worker process started — listening on registered BullMQ queues');
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'worker bootstrap failed');
  void otel.shutdown().finally(() => process.exit(1));
});
