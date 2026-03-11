import { env } from '@bge/env';
import { walkDir } from '@bge/utils';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])gateway([/\\]|$)/]);
  Logger.log(`Loading gRPC proto files from: ${protoPaths.join(', ')}`);
  const url = `${env.provide('COORDINATOR_GRPC_HOST')}:${env.provide('COORDINATOR_GRPC_PORT')}`;
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    options: {
      url,
      package: 'bge.coordinator.v1',
      protoPath: protoPaths,
      loader: {
        includeDirs: [path.join(__dirname, 'proto')],
      },
    },
  });
  await app.listen();
  Logger.log(`🚀 Application is running on: grpc://${url}`);
}

bootstrap();
