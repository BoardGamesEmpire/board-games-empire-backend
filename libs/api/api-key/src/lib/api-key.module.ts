import { AuditContextModule } from '@bge/actor-context';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';

/**
 * A user's own API keys (#1417): the list of permissions a new key may hold,
 * and the create route #1418 adds. It imports no other API feature lib.
 */
@Module({
  imports: [AuditContextModule, PermissionsModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
