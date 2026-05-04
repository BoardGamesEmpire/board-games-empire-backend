import { Module } from '@nestjs/common';
import { BggModule } from '../bgg/bgg.module';
import { GameGatewayController } from './game-gateway.controller';
import { GameGatewayService } from './game-gateway.service';

@Module({
  imports: [BggModule],
  controllers: [GameGatewayController],
  providers: [GameGatewayService],
})
export class GameGatewayModule {}
