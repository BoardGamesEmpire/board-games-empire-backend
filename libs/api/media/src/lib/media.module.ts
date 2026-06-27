import { DatabaseModule } from '@bge/database';
import { StorageModule } from '@bge/storage';
import { Module } from '@nestjs/common';
import { MediaObjectController } from './media-object.controller';
import { MediaObjectService } from './media-object.service';
import { MediaStreamController } from './media-stream.controller';

@Module({
  imports: [DatabaseModule, StorageModule],
  controllers: [MediaStreamController, MediaObjectController],
  providers: [MediaObjectService],
  exports: [MediaObjectService],
})
export class MediaModule {}
