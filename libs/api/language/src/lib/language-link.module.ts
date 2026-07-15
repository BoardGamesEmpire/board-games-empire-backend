import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { LanguageLinkService } from './language-link.service';

/**
 * Controller-free module exposing LanguageLinkService — importable by gRPC
 * worker apps (coordinator, import workers) without mounting the language
 * HTTP endpoints.
 */
@Module({
  imports: [DatabaseModule],
  providers: [LanguageLinkService],
  exports: [LanguageLinkService],
})
export class LanguageLinkModule {}
