import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice(AppModule, {
    transport: Transport.GRPC,
    // TODO: all of this
    options: {
      package: 'your_package_name',
      protoPath: 'path/to/your/proto/file.proto',
    },
  });
  await app.listen();
  Logger.log(`🚀 Application is running on: http://localhost`);
}

bootstrap();
