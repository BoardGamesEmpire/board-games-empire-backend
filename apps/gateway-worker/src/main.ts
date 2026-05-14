import { env } from '@bge/env';
import { Logger } from '@nestjs/common';
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

  if (env.provide('USE_PINO_LOGGER') === 'true') {
    app.useLogger(app.get(PinoLogger));
  }

  app.enableShutdownHooks();

  Logger.log('🛰️  Gateway worker process started — connected to gateway registry, awaiting BullMQ jobs');
}

bootstrap().catch((err) => {
  Logger.error('Gateway worker bootstrap failed', err);
  process.exit(1);
});
