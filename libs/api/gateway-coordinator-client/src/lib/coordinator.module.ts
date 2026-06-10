import { createOutboundActorMetadataInterceptor } from '@bge/actor-context-transport';
import type { ChannelOptions } from '@grpc/grpc-js';
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
              // grpc-js `ClientOptions` extends `ChannelOptions` with an
              // `interceptors` array — NestJS forwards `channelOptions`
              // unchanged to the grpc-js Client constructor, so the
              // outbound actor-metadata interceptor wires here. OTel's
              // grpc auto-instrumentation chains around this and handles
              // W3C trace context propagation independently.
              //
              // No fallback actor is configured: the strict outbound
              // interceptor refuses to invent an actor when CLS is empty,
              // and the coordinator's inbound interceptor enforces the
              // matching strict policy. System-initiated callers must
              // enter a CLS scope via `SystemActorScope` (from
              // `@bge/actor-context`) before issuing gRPC calls.
              channelOptions: {
                interceptors: [createOutboundActorMetadataInterceptor()],
              } as ChannelOptions,
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
