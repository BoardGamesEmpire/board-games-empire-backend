import { actorUserId } from '@bge/actor-context';
import { DatabaseService, Prisma, type AuditLog } from '@bge/database';
import type { PaginatedRows } from '@bge/shared';
import { Injectable } from '@nestjs/common';
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

  /**
   * Admin read path: soft-deleted rows excluded, newest first, plus the total
   * matching row count for the response envelope (#372).
   *
   * That count is the one on this sweep whose cost is worth naming. `total` is
   * unconditional (D-230-2) and Postgres has no cheap count, so an unfiltered
   * page is an index scan over every live row of a table that grows without
   * bound. `@@index([deletedAt, occurredAt])` is what keeps it to the live-row
   * prefix rather than a heap walk. Accepted deliberately: this is an admin
   * route at 50 rows a page, and an approximate `total` (`reltuples`, or a
   * capped count) would hand a wrong `totalPages` to the one audience that
   * reads a page count as a claim about the record. Revisit if it is ever
   * measured to hurt, not before.
   */
  async list(query: ListAuditLogsQueryDto): Promise<PaginatedRows<AuditLog>> {
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

    // One snapshot for both: under the database default the count could see a
    // retention sweep the rows did not, and `hasMore` would promise a page that
    // no longer exists.
    const [rows, total] = await this.db.$transaction(
      [
        this.db.auditLog.findMany({
          where,
          // `id` breaks ties on `occurredAt`: entries emitted in one transaction
          // share a timestamp, so a tie-less sort lets them drift across pages.
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.auditLog.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }
}
