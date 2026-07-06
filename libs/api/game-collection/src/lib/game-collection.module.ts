import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GameCollectionController } from './game-collection.controller';
import { GameCollectionService } from './game-collection.service';

@Module({
  imports: [DatabaseModule],
  controllers: [GameCollectionController],
  providers: [GameCollectionService],
  exports: [GameCollectionService],
})
export class GameCollectionModule {}
