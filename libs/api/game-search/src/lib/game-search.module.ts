import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GameSearchController } from './game-search.controller';
import { GameSearchService } from './game-search.service';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule],
  controllers: [GameSearchController],
  providers: [GameSearchService],
  exports: [GameSearchService],
})
export class GameSearchModule {}
