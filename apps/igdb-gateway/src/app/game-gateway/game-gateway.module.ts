import { Module } from '@nestjs/common';
import { IGDBService } from '../igdb/igdb.service';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

@Module({
  controllers: [GameGatewayController],
  providers: [IGDBService, GameGatewayService],
})
export class GameGatewayModule {}
