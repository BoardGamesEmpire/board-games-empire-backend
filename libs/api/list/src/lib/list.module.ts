import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { ListEntryController } from './list-entry.controller';
import { ListEntryService } from './list-entry.service';
import { ListController } from './list.controller';
import { ListService } from './list.service';
import { UserListsController } from './user-lists.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ListController, ListEntryController, UserListsController],
  providers: [ListService, ListEntryService],
  exports: [ListService, ListEntryService],
})
export class ListModule {}
