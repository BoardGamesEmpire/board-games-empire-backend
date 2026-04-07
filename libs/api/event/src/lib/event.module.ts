import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { EventController } from './event.controller';
import { EventService } from './event.service';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [EventController],
  providers: [EventService],
  exports: [EventService],
})
export class EventModule {}
