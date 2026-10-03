import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GameCollectionController } from './game-collection.controller';
import { GameCollectionService } from './game-collection.service';
import { UserGameCollectionsController } from './user-game-collections.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [GameCollectionController, UserGameCollectionsController],
  providers: [GameCollectionService],
  exports: [GameCollectionService],
})
export class GameCollectionModule {}
