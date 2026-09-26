import { actorUserId } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';
import type { RecordAuditEntry } from '../interfaces/record-audit-entry.interface';
import { toJsonValue } from '../utils/audit-snapshot.util';

/**
 * The audit trail's writer, hosted in every process that emits domain events.
 * The admin read lives in `AuditLogQueryService`, api only, because it needs
 * the permissions layer and this does not.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Persists one audit row. `actorKind` / `actorUserId` are denormalized from
   * the actor union at write time (plugin chains resolve to their originating
   * trigger) so the admin filters run on indexed scalar columns instead of
   * JSON path expressions.
   */
  async record(entry: RecordAuditEntry): Promise<void> {
    await this.db.auditLog.create({
      data: {
        event: entry.event,
        actor: toJsonValue(entry.actor),
        actorKind: entry.actor.kind,
        actorUserId: actorUserId(entry.actor),
        action: entry.action,
        subject: entry.subject,
        subjectId: entry.subjectId,
        source: entry.source,
        correlationId: entry.correlationId,
        payload: toJsonValue({ before: entry.before, after: entry.after }),
        initiatedAt: entry.initiatedAt,
        occurredAt: entry.occurredAt,
      },
    });
  }
}
