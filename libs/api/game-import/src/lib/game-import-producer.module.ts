import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import { GameImportController } from './game-import.controller';
import { GameImportProducerService } from './services/game-import-producer.service';

@Module({
  imports: [
    DatabaseModule,
    GatewayCoordinatorClientModule,
    BullModule.registerQueue({ name: QueueNames.GamesImport }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
  ],
  controllers: [GameImportController],
  providers: [GameImportProducerService],
  exports: [GameImportProducerService],
})
export class GameImportProducerModule {}
