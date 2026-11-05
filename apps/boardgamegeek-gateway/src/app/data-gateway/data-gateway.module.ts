import { BoardGameGeekDriver } from '@bge/gateway-driver-boardgamegeek';
import { createDriverLogger, DATA_GATEWAY_DRIVER, DataGatewayController, nodeUpstreamFetch } from '@bge/gateway-host';
import { BGE_VERSION } from '@bge/version';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BoardGameGeekConfig } from '../configuration/boardgamegeek.config';

/**
 * Serves BoardGameGeek as a remote DataGateway: the shared gRPC controller
 * over BoardGameGeekDriver, which reaches BGG through Node's fetch and
 * reports the BGE version on Ping (#1082).
 */
@Module({
  controllers: [DataGatewayController],
  providers: [
    {
      provide: DATA_GATEWAY_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new BoardGameGeekDriver({
          fetch: nodeUpstreamFetch,
          apiKey: config.getOrThrow<BoardGameGeekConfig>('boardgamegeek').apiKey,
          version: BGE_VERSION,
          logger: createDriverLogger(BoardGameGeekDriver.name),
        }),
    },
  ],
})
export class DataGatewayModule {}
