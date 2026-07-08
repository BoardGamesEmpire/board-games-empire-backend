import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import { GameWatchListener } from './listeners/game-watch.listener';
import { ImportActivityListener } from './listeners/import-activity.listener';
import { NotificationListener } from './listeners/notification.listener';
import { GameImportProcessor } from './processors/game-import.processor';
import { ImportBatchCompletionService } from './services/batch-completion.service';
import { ExpansionSpawnerService } from './services/expansion-spawner.service';
import { GameUpsertService } from './services/game.service';
import { PersonUpsertService } from './services/person.service';
import { PlatformUpsertService } from './services/platform.service';
import { ReleaseGraphResolver } from './services/release-graph.resolver';
import { TaxonomyUpsertService } from './services/taxonomy.service';

@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    NotificationsServiceModule,
    // GamesImport: consumed here (GameImportProcessor) and produced (spawner).
    // GatewayFetch: producer only — the spawner enqueues expansion fetch jobs,
    // but this app registers NO fetch @Processor, so the worker never calls a
    // gateway (that stays exclusively in apps/gateway-worker).
    BullModule.registerQueue({ name: QueueNames.GamesImport }, { name: QueueNames.GatewayFetch }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
  ],
  providers: [
    ExpansionSpawnerService,
    GameImportProcessor,
    GameUpsertService,
    GameWatchListener,
    ImportBatchCompletionService,
    ImportActivityListener,
    NotificationListener,
    PersonUpsertService,
    PlatformUpsertService,
    ReleaseGraphResolver,
    TaxonomyUpsertService,
  ],
})
export class GameImportConsumerModule {}
