import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogModule } from './audit-log.module';

/**
 * HTTP surface for the audit trail — api app only. Split from
 * `AuditLogModule` so worker processes can host the capture listener without
 * dragging in controller wiring.
 */
@Module({
  imports: [AuditLogModule],
  controllers: [AuditLogController],
})
export class AuditLogApiModule {}
