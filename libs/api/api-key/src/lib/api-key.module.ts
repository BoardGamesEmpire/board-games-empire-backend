import { AuditContextModule } from '@bge/actor-context';
import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';

/**
 * A user's own API keys (#1417, #1418): the list of permissions a new key may
 * hold, and creating, reading, editing and deleting keys. Its one import from
 * another API feature lib is `@bge/auth`, whose `AuthService` creates a key
 * through better-auth, which makes and hashes the secret (#1418).
 */
@Module({
  imports: [AuditContextModule, AuthModule, DatabaseModule, PermissionsModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
