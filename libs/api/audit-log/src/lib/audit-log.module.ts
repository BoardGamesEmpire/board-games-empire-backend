import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { Module } from '@nestjs/common';
import { AuditLogService } from './services/audit-log.service';
import { AuditPersistenceListener } from './services/audit-persistence.listener';
import { AuditUnattributedNotifierService } from './services/audit-unattributed-notifier.service';

/**
 * Core audit capture: the onAny persistence listener + row writer. Register
 * in EVERY process that emits domain events (api, worker, gateway-worker,
 * gateway-coordinator — the same fan-out as `WebhooksModule`), so audit rows
 * are captured wherever mutations happen. Requires a global ClsModule and
 * EventEmitterModule in the host app.
 *
 * The admin read endpoint lives in `AuditLogApiModule` (api only); the
 * retention sweep in `AuditRetentionModule` (worker only).
 */
@Module({
  imports: [AuditContextModule, DatabaseModule, NotificationsServiceModule],
  providers: [AuditLogService, AuditUnattributedNotifierService, AuditPersistenceListener],
  exports: [AuditLogService],
})
export class AuditLogModule {}
