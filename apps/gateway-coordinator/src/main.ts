import { env } from '@bge/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // TODO: recursive proto loading
  const protoPath = path.join(__dirname, 'proto', 'bge', 'coordinator', 'v1', 'coordinator.proto');
  Logger.log(`Loading gRPC proto files from: ${protoPath}`);
  const url = `${env.provide('COORDINATOR_GRPC_HOST')}:${env.provide('COORDINATOR_GRPC_PORT')}`;
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    options: {
      url,
      package: 'bge.coordinator.v1',
      protoPath: [protoPath],
      loader: {
        includeDirs: [path.join(__dirname, 'proto')],
      },
    },
  });
  await app.listen();
  Logger.log(`🚀 Application is running on: grpc://${url}`);
}

bootstrap();
