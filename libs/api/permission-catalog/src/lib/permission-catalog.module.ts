import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { PermissionCatalogController } from './permission-catalog.controller';
import { PermissionCatalogService } from './permission-catalog.service';

/**
 * The Owner's routes over the permission catalog (#772). `PermissionsService`
 * (the cache flush) and `EventEmitter2` are global in every process that
 * mounts this module.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [PermissionCatalogController],
  providers: [PermissionCatalogService],
})
export class PermissionCatalogModule {}
