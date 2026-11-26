import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { CollectionCopyController } from './collection-copy.controller';
import { CollectionCopyService } from './collection-copy.service';
import { CollectionWriteService } from './collection-write.service';
import { GameCollectionController } from './game-collection.controller';
import { GameCollectionService } from './game-collection.service';
import { UserGameCollectionsController } from './user-game-collections.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [GameCollectionController, UserGameCollectionsController, CollectionCopyController],
  providers: [CollectionCopyService, CollectionWriteService, GameCollectionService],
  exports: [GameCollectionService],
})
export class GameCollectionModule {}
