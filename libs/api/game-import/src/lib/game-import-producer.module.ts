import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import { GameImportController } from './game-import.controller';
import { GameImportProducerService } from './services/game-import-producer.service';

/**
 * Producer-side surface for the game-import domain. Imported by apps that
 * enqueue import jobs (the API). Does NOT register the processor or upsert
 * services — those live in the consumer module that runs in the worker app.
 *
 * Both modules register the same QueueNames.GamesImport queue — BullMQ
 * routes jobs from this module's FlowProducer to the consumer module's
 * processor via Redis.
 */
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
