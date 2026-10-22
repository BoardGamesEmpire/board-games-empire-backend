import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { LanguageLinkModule } from '@bge/language';
import { VocabularyLinkModule } from '@bge/vocabulary';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VOCABULARY_SECTION_QUEUE } from './constants/vocabulary-section.constants';
import { VocabularySectionProcessor } from './vocabulary-section.processor';
import { VocabularySectionService } from './vocabulary-section.service';

/**
 * Consumer end of the list jobs (#718). Imported by the gateway worker only,
 * so only it asks a DataGateway for its lists; the coordinator queues them
 * after its interviews through `GatewayRegistryModule`, which also supplies,
 * globally, the registry and interview services the processor runs through.
 * `AuditContextModule` satisfies the `ActorAwareWorkerHost` CLS requirement.
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    LanguageLinkModule,
    VocabularyLinkModule,
    BullModule.registerQueue({ name: VOCABULARY_SECTION_QUEUE }),
  ],
  providers: [VocabularySectionService, VocabularySectionProcessor],
})
export class VocabularySectionConsumerModule {}
