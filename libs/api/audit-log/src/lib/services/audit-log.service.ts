import { actorUserId } from '@bge/actor-context';
import { DatabaseService, Prisma, type AuditLog } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { AUDIT_LOG_DEFAULT_PAGE_SIZE } from '../constants/audit-log.constants';
import type { ListAuditLogsQueryDto } from '../dto';
import type { RecordAuditEntry } from '../interfaces/record-audit-entry.interface';
import { toJsonValue } from '../utils/audit-snapshot.util';

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

  /** Admin read path: soft-deleted rows excluded, newest first. */
  async list(query: ListAuditLogsQueryDto): Promise<AuditLog[]> {
    const where: Prisma.AuditLogWhereInput = {
      deletedAt: null,
      ...(query.subject && { subject: query.subject }),
      ...(query.subjectId && { subjectId: query.subjectId }),
      ...(query.actorKind && { actorKind: query.actorKind }),
      ...(query.actorUserId && { actorUserId: query.actorUserId }),
      ...(query.event && { event: query.event }),
      ...(query.action && { action: query.action }),
      ...(query.source && { source: query.source }),
      ...(query.correlationId && { correlationId: query.correlationId }),
    };

    if (query.occurredFrom || query.occurredTo) {
      where.occurredAt = {
        ...(query.occurredFrom && { gte: query.occurredFrom }),
        ...(query.occurredTo && { lt: query.occurredTo }),
      };
    }

    return this.db.auditLog.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: query.offset,
      take: query.limit ?? AUDIT_LOG_DEFAULT_PAGE_SIZE,
    });
  }
}
