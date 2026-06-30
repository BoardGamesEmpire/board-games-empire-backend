import 'reflect-metadata';

import { env } from '@bge/env';
import { registerLoggerShutdown } from '@bge/logger';
import { walkDir } from '@bge/utils';
import { PROTO_PACKAGE_NAME } from '@boardgamesempire/proto-gateway';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { Logger as PinoLogger } from 'nestjs-pino';
import * as path from 'node:path';
import { AppModule } from './app/app.module';
import { bootstrapLogger } from './app/lib/logger';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  bootstrapLogger.debug(`Bootstrapping BoardgamesEmpire IGDB Gateway in ${env.currentEnv} mode`);

  const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])coordinator([/\\]|$)/]);
  bootstrapLogger.info({ protoPaths }, 'loading gRPC proto files');

  const url = `${env.provide('IGDB_GATEWAY_GRPC_HOST')}:${env.provide('IGDB_GATEWAY_GRPC_PORT')}`;

  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    // Buffer module-init logs until `useLogger` is called below, so
    // they flow through nestjs-pino rather than Nest's default
    // ConsoleLogger going to stdout.
    bufferLogs: true,
    options: {
      url,
      package: PROTO_PACKAGE_NAME,
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

  // `enableShutdownHooks()` is intentionally omitted — the handlers
  // registered below sequence `app.close()` before flushing pino so
  // the trailing batch of log records is not dropped.
  registerLoggerShutdown(app, bootstrapLogger);

  await app.listen();
  bootstrapLogger.info({ url }, '🚀 application is running on grpc');
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'bootstrap failed');
  bootstrapLogger.flush(() => process.exit(1));
});
