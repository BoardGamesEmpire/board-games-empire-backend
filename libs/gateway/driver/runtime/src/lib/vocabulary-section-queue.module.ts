import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VOCABULARY_SECTION_QUEUE } from './constants/vocabulary-section.constants';
import { VocabularySectionQueue } from './vocabulary-section.queue';

/**
 * Producer end of the list jobs (#718). Registers the queue for enqueue
 * only. `GatewayRegistryModule` imports it for the interview's jobs, and the
 * API for the jobs of a list an admin switches back on. Their consumer is
 * `VocabularySectionConsumerModule`.
 */
@Module({
  imports: [BullModule.registerQueue({ name: VOCABULARY_SECTION_QUEUE })],
  providers: [VocabularySectionQueue],
  exports: [VocabularySectionQueue],
})
export class VocabularySectionQueueModule {}
