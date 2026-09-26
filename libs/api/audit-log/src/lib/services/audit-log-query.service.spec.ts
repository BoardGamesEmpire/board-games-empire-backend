import { Action, Prisma, ResourceType } from '@bge/database';
import { ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createMockDatabaseService,
  MOCK_RESOURCE_CONDITION,
  shippedReadReaches,
  type MockDatabaseService,
} from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { AUDIT_LOG_DEFAULT_PAGE_SIZE } from '../constants/audit-log.constants';
import { ListAuditLogsQueryDto } from '../dto';
import { AuditLogQueryService } from './audit-log-query.service';

/**
 * A bound `ListAuditLogsQueryDto`. Built through the DTO rather than cast from a
 * literal because `skip`/`pageSize` are derived accessors (#230) — a cast object
 * would let a test assert paging the DTO never computed.
 */
const auditQuery = (init: Partial<ListAuditLogsQueryDto> = {}) =>
  plainToInstance(ListAuditLogsQueryDto, init, { enableImplicitConversion: true });

/** The composed ceiling, with the soft-delete and caller filters beside it. */
const composedWith = (filters: Prisma.AuditLogWhereInput) => ({
  AND: [{ AND: [MOCK_RESOURCE_CONDITION] }, filters],
});

describe('AuditLogQueryService', () => {
  let db: MockDatabaseService;
  let service: AuditLogQueryService;
  let compose: jest.SpyInstance;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.auditLog.findMany.mockResolvedValue([]);
    db.auditLog.count.mockResolvedValue(0);

    // The REAL composer over a mocked ability service, so the where-clause
    // assertions below test the merge the read actually depends on.
    const composer = new ScopeComposer(createMockAbilityService() as never);
    compose = jest.spyOn(composer, 'compose');
    service = new AuditLogQueryService(db as never, composer);
  });

  it('composes AuditLog as unscoped', async () => {
    await service.list(auditQuery());

    expect(compose).toHaveBeenCalledWith(
      ResourceType.AuditLog,
      Action.read,
      expect.objectContaining({ kind: 'unscoped', reason: expect.any(String) }),
    );
  });

  // The Unscoped reason is a claim about the catalog, and this is where it is
  // checked: a conditioned read granted later fails here, beside the
  // declaration it would falsify, and not only in the catalog's own pin.
  it('stays unscoped only while every catalog role that reads audit logs reads every row', () => {
    expect(new Set(shippedReadReaches(ResourceType.AuditLog))).toEqual(new Set(['every row']));
  });

  it('excludes soft-deleted rows, sorts newest first, and applies default paging', async () => {
    await service.list(auditQuery());

    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: composedWith({ deletedAt: null }),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: AUDIT_LOG_DEFAULT_PAGE_SIZE,
    });
  });

  it('applies scalar filters when present', async () => {
    await service.list(
      auditQuery({
        page: 3,
        limit: 5,
        subject: 'Event',
        subjectId: 'e1',
        actorKind: 'user',
        actorUserId: 'u1',
        event: 'event.created',
        action: 'create',
        source: 'http',
        correlationId: 'corr-1',
      }),
    );

    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: composedWith({
        deletedAt: null,
        subject: 'Event',
        subjectId: 'e1',
        actorKind: 'user',
        actorUserId: 'u1',
        event: 'event.created',
        action: 'create',
        source: 'http',
        correlationId: 'corr-1',
      }),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 5,
    });
  });

  it('builds a half-open occurredAt range (gte from, lt to)', async () => {
    const occurredFrom = new Date('2026-01-01T00:00:00.000Z');
    const occurredTo = new Date('2026-02-01T00:00:00.000Z');

    await service.list(auditQuery({ occurredFrom, occurredTo }));

    const args = db.auditLog.findMany.mock.calls[0][0];
    expect(args?.where).toEqual(composedWith({ deletedAt: null, occurredAt: { gte: occurredFrom, lt: occurredTo } }));
  });

  it('supports a one-sided range', async () => {
    const occurredFrom = new Date('2026-01-01T00:00:00.000Z');

    await service.list(auditQuery({ occurredFrom }));

    const args = db.auditLog.findMany.mock.calls[0][0];
    expect(args?.where).toEqual(composedWith({ deletedAt: null, occurredAt: { gte: occurredFrom } }));
  });

  // #372: rows and count share one snapshot, or the retention sweep running
  // between them makes `hasMore` promise a page that no longer exists.
  it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
    await service.list(auditQuery());

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  // The filters are the expensive part of this read; a count that skipped them
  // would report the size of the whole table as the size of a filtered view.
  it('counts through the same filtered where as the rows', async () => {
    db.auditLog.count.mockResolvedValue(4);

    const page = await service.list(auditQuery({ subject: 'Event', subjectId: 'e1' }));

    expect(db.auditLog.count).toHaveBeenCalledWith({
      where: composedWith({ deletedAt: null, subject: 'Event', subjectId: 'e1' }),
    });
    expect(page).toEqual({ rows: [], total: 4 });
  });
});
