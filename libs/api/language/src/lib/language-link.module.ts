import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { LanguageLinkReviewService } from './language-link-review.service';
import { LanguageLinkService } from './language-link.service';

/**
 * Controller-free module exposing LanguageLinkService — importable by gRPC
 * worker apps (coordinator, import workers) without mounting the language
 * HTTP endpoints. The review service is here for the DataGateway routes that
 * review a DataGateway's links (#715).
 */
@Module({
  imports: [DatabaseModule],
  providers: [LanguageLinkService, LanguageLinkReviewService],
  exports: [LanguageLinkService, LanguageLinkReviewService],
})
export class LanguageLinkModule {}
