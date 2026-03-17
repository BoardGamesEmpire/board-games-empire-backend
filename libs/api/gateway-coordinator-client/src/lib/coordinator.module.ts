import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { configuration } from './configuration';
import { COORDINATOR_SERVICE_TOKEN } from './constants';
import { GatewayCoordinatorClientService } from './coordinator.service';

@Module({
  imports: [
    ConfigModule.forFeature(configuration.coordinator),
    ClientsModule.registerAsync({
      clients: [
        {
          name: COORDINATOR_SERVICE_TOKEN,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            transport: Transport.GRPC,
            options: {
              url: `${config.getOrThrow('coordinatorClient.host')}:${config.getOrThrow('coordinatorClient.port')}`,
              package: 'bge.coordinator.v1',
              protoPath: [path.join(__dirname, 'proto', 'bge', 'coordinator', 'v1', 'coordinator.proto')],
              loader: {
                includeDirs: [path.join(__dirname, 'proto')],
                arrays: true,
                longs: String,
                enums: String,
              },
            },
          }),
        },
      ],
    }),
  ],
  providers: [GatewayCoordinatorClientService],
  exports: [GatewayCoordinatorClientService],
})
export class GatewayCoordinatorClientModule {}
