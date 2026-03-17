import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BggClient } from 'bgg-ts-client';
import type { BoardGameGeekConfig } from '../configuration/boardgamegeek.config';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

@Module({
  controllers: [GameGatewayController],
  providers: [
    {
      provide: BggClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const bggConfig = configService.getOrThrow<BoardGameGeekConfig>('boardgamegeek');
        return BggClient.Create(bggConfig);
      },
    },
    GameGatewayService,
  ],
})
export class GameGatewayModule {}
