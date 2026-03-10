import { env } from '@bge/env';
import { PROTO_PACKAGE_NAME } from '@board-games-empire/proto-gateway';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { AppModule } from './app/app.module';

async function bootstrap() {
  // TODO: recursive proto loading
  const protoPath = path.join(__dirname, 'proto', 'bge', 'gateway', 'v1', 'gateway.proto');
  Logger.log(`Loading gRPC proto files from: ${protoPath}`);
  const url = `${env.provide('GATEWAY_GRPC_HOST')}:${env.provide('GATEWAY_GRPC_PORT')}`;
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    options: {
      url,
      package: PROTO_PACKAGE_NAME,
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
