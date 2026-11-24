import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { FlowProducerNames, QueueNames } from '@bge/game-import';
import { GatewayGameSearchModule } from '@bge/gateway-game-search';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

@Module({
  imports: [
    // AuditContextModule is not global; the enqueuer reads the CLS actor (#650).
    AuditContextModule,
    DatabaseModule,
    BullModule.registerQueue({ name: QueueNames.GamesImport }, { name: QueueNames.GatewayFetch }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
    GatewayGameSearchModule,
  ],
  controllers: [CoordinatorController],
  providers: [CoordinatorService, GameImportEnqueuerService],
})
export class CoordinatorModule {}
