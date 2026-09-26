import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogModule } from './audit-log.module';
import { AuditLogQueryService } from './services/audit-log-query.service';

/**
 * HTTP surface for the audit trail — api app only. Split from
 * `AuditLogModule` so worker processes can host the capture listener without
 * dragging in controller wiring. The read's `ScopeComposer` comes from the
 * global `PermissionsModule`, which the api loads and the gateway coordinator
 * (another `AuditLogModule` host) does not — so the read's service is
 * provided here, not there.
 *
 * The `AuditLogModule` import is not for the controller, which uses none of
 * its exports. It is how the api process registers the capture listener: this
 * module is the api's only route to it, so removing the import as unused
 * would silently stop audit rows for every HTTP mutation.
 */
@Module({
  imports: [AuditLogModule, DatabaseModule],
  controllers: [AuditLogController],
  providers: [AuditLogQueryService],
})
export class AuditLogApiModule {}
