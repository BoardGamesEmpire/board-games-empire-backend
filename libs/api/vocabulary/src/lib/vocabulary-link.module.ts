import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { VocabularyLinkReviewService } from './vocabulary-link-review.service';
import { VocabularyLinkService } from './vocabulary-link.service';

/**
 * Controller-free module exposing the vocabulary matching (#718): import
 * and the list jobs resolve entries through VocabularyLinkService, and the
 * DataGateway routes review the links through VocabularyLinkReviewService.
 */
@Module({
  imports: [DatabaseModule],
  providers: [VocabularyLinkService, VocabularyLinkReviewService],
  exports: [VocabularyLinkService, VocabularyLinkReviewService],
})
export class VocabularyLinkModule {}
