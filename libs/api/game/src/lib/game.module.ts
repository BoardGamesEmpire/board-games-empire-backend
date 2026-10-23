import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { GameShareNotificationListener } from './share/game-share-notification.listener';
import { GameShareController } from './share/game-share.controller';
import { GameShareService } from './share/game-share.service';

@Module({
  imports: [DatabaseModule, PermissionsModule, NotificationsServiceModule],
  controllers: [GameController, GameShareController],
  providers: [GameService, GameShareService, GameShareNotificationListener],
  exports: [GameService],
})
export class GameModule {}
