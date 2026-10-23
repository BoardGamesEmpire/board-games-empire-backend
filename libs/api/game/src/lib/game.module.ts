import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { GameShareController } from './share/game-share.controller';
import { GameShareService } from './share/game-share.service';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [GameController, GameShareController],
  providers: [GameService, GameShareService],
  exports: [GameService],
})
export class GameModule {}
