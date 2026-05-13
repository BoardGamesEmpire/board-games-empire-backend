import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueNames } from './constants/queue.constants';
import { GameWatchListener } from './listeners/game-watch.listener';
import { ImportActivityListener } from './listeners/import-activity.listener';
import { NotificationListener } from './listeners/notification.listener';
import { GameImportProcessor } from './processors/game-import.processor';
import { GameUpsertService } from './services/game.service';
import { PersonUpsertService } from './services/person.service';
import { PlatformUpsertService } from './services/platform.service';
import { ReleaseGraphResolver } from './services/release-graph.resolver';
import { TaxonomyUpsertService } from './services/taxonomy.service';

@Module({
  imports: [DatabaseModule, NotificationsServiceModule, BullModule.registerQueue({ name: QueueNames.GamesImport })],
  providers: [
    GameImportProcessor,
    GameUpsertService,
    GameWatchListener,
    ImportActivityListener,
    NotificationListener,
    PersonUpsertService,
    PlatformUpsertService,
    ReleaseGraphResolver,
    TaxonomyUpsertService,
  ],
})
export class GameImportConsumerModule {}
