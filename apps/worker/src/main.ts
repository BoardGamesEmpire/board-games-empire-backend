import { env } from '@bge/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { WorkerModule } from './app/worker.module';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  if (env.provide('USE_PINO_LOGGER') === 'true') {
    app.useLogger(app.get(PinoLogger));
  }

  app.enableShutdownHooks();

  Logger.log('🔧 Worker process started — listening on registered BullMQ queues');
}

bootstrap().catch((err) => {
  Logger.error('Worker bootstrap failed', err);
  process.exit(1);
});
