import { Action, DatabaseService, Prisma, ResourceType, type AuditLog } from '@bge/database';
import { ScopeComposer, Unscoped } from '@bge/permissions';
import type { PaginatedRows } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import type { ListAuditLogsQueryDto } from '../dto';

/**
 * The admin read of the audit trail — api only, provided by
 * `AuditLogApiModule`.
 *
 * Split from `AuditLogService` because the two live in different processes.
 * The writer is registered wherever domain events are emitted, including the
 * gateway coordinator, which loads no permissions layer; this read needs
 * `ScopeComposer`, and injecting it into the writer would break the
 * coordinator's boot for a route it never mounts (#516).
 */
@Injectable()
export class AuditLogQueryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * Soft-deleted rows excluded, newest first, plus the total matching row
   * count for the response envelope (#372).
   *
   * Composed as `Unscoped` (#516; `ScopeComposer.compose` says why a read
   * with no scope composes at all): the trail has no per-caller row set to
   * name. The soft-delete filter and the query's filters are the same for
   * every caller or the caller's own input, not a scope, so they sit beside
   * the composed clause.
   *
   * The count is the one on the #372 pagination sweep whose cost is worth
   * naming. `total` is unconditional (#230) and Postgres has no cheap count,
   * so an unfiltered page is an index scan over every live row of a table that
   * grows without bound. `@@index([deletedAt, occurredAt])` is what keeps it to the live-row
   * prefix rather than a heap walk. Accepted deliberately: this is an admin
   * route at 50 rows a page, and an approximate `total` (`reltuples`, or a
   * capped count) would hand a wrong `totalPages` to the one audience that
   * reads a page count as a claim about the record. Revisit if it is ever
   * measured to hurt, not before.
   */
  async list(query: ListAuditLogsQueryDto): Promise<PaginatedRows<AuditLog>> {
    const filters: Prisma.AuditLogWhereInput = {
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
      filters.occurredAt = {
        ...(query.occurredFrom && { gte: query.occurredFrom }),
        ...(query.occurredTo && { lt: query.occurredTo }),
      };
    }

    const where: Prisma.AuditLogWhereInput = {
      AND: [
        this.scopeComposer.compose(
          ResourceType.AuditLog,
          Action.read,
          Unscoped(
            'staff-only audit trail: every catalog role that reads audit logs reads every row (KNOWN_READ_CEILINGS)',
          ),
        ),
        filters,
      ],
    };

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
