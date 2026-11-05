import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { GameModule } from '@bge/game';
import { Module } from '@nestjs/common';
import { GameSearchController } from './game-search.controller';
import { GameSearchService } from './game-search.service';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule, GameModule],
  controllers: [GameSearchController],
  providers: [GameSearchService],
  exports: [GameSearchService],
})
export class GameSearchModule {}
