import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { GameController } from './game.controller';
import { GameService } from './game.service';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [GameController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
