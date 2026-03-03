import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [DatabaseModule],
  providers: [AbilityFactory, PermissionsService],
  exports: [AbilityFactory, PermissionsService],
})
export class PermissionsModule {}
