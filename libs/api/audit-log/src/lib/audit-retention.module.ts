import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { AuditRetentionService } from './services/audit-retention.service';

/**
 * Worker-only (mirrors `MediaSweepModule`): hosts the periodic retention
 * sweep so it runs in exactly one process. Requires the host to register
 * ScheduleModule.forRoot() + a global ClsModule (the worker does both).
 */
@Module({
  imports: [AuditContextModule, DatabaseModule],
  providers: [AuditRetentionService],
  exports: [AuditRetentionService],
})
export class AuditRetentionModule {}
