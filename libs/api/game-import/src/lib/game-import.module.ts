import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import { GameWatchListener } from './listeners/game-watch.listener';
import { ImportActivityListener } from './listeners/import-activity.listener';
import { NotificationListener } from './listeners/notification.listener';
import { GameImportProcessor } from './processors/game-import.processor';
import { GameImportProducerService } from './services/game-import-producer.service';
import { GameUpsertService } from './services/game.service';
import { PersonUpsertService } from './services/person.service';
import { PlatformUpsertService } from './services/platform.service';
import { TaxonomyUpsertService } from './services/taxonomy.service';

@Module({
  imports: [
    DatabaseModule,
    GatewayCoordinatorClientModule,
    NotificationsServiceModule,

    BullModule.registerQueue({ name: QueueNames.GamesImport }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
  ],
  providers: [
    TaxonomyUpsertService,
    PersonUpsertService,
    PlatformUpsertService,
    GameUpsertService,
    GameImportProcessor,
    GameImportProducerService,
    GameWatchListener,
    NotificationListener,
    ImportActivityListener,
  ],
  exports: [GameImportProducerService],
})
export class GameImportModule {}
