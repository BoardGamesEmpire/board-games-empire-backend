import type { Actor } from '@bge/actor-context';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { AUDIT_LOG_DEFAULT_PAGE_SIZE } from '../constants/audit-log.constants';
import type { ListAuditLogsQueryDto } from '../dto';
import type { RecordAuditEntry } from '../interfaces/record-audit-entry.interface';
import { AuditLogService } from './audit-log.service';

const baseEntry: RecordAuditEntry = {
  event: 'event.created',
  actor: { kind: 'user', userId: 'u1' },
  action: 'create',
  subject: 'Event',
  subjectId: 'e1',
  source: 'http',
  correlationId: 'corr-1',
  before: null,
  after: { id: 'e1', title: 'Game night' },
  initiatedAt: new Date('2026-01-15T10:00:00.000Z'),
  occurredAt: new Date('2026-01-15T10:00:01.000Z'),
};

describe('AuditLogService', () => {
  let db: MockDatabaseService;
  let service: AuditLogService;

  beforeEach(() => {
    db = createMockDatabaseService();
    service = new AuditLogService(db as never);
  });

  describe('record', () => {
    it('persists the row with denormalized actor columns', async () => {
      await service.record(baseEntry);

      expect(db.auditLog.create).toHaveBeenCalledWith({
        data: {
          event: 'event.created',
          actor: { kind: 'user', userId: 'u1' },
          actorKind: 'user',
          actorUserId: 'u1',
          action: 'create',
          subject: 'Event',
          subjectId: 'e1',
          source: 'http',
          correlationId: 'corr-1',
          payload: { before: null, after: { id: 'e1', title: 'Game night' } },
          initiatedAt: baseEntry.initiatedAt,
          occurredAt: baseEntry.occurredAt,
        },
      });
    });

    it('resolves plugin actor chains to the owning userId', async () => {
      const plugin: Actor = {
        kind: 'plugin',
        pluginId: 'p1',
        trigger: { kind: 'apiKey', apiKeyId: 'k1', userId: 'u9' },
      };

      await service.record({ ...baseEntry, actor: plugin });

      const data = db.auditLog.create.mock.calls[0][0].data;
      expect(data.actorKind).toBe('plugin');
      expect(data.actorUserId).toBe('u9');
    });

    it('records null actorUserId for system actors', async () => {
      await service.record({ ...baseEntry, actor: { kind: 'system', reason: 'migration' } });

      const data = db.auditLog.create.mock.calls[0][0].data;
      expect(data.actorKind).toBe('system');
      expect(data.actorUserId).toBeNull();
    });

    it('serializes snapshot Dates into the payload json', async () => {
      await service.record({ ...baseEntry, after: { id: 'e1', startsAt: new Date('2026-02-01T00:00:00.000Z') } });

      const data = db.auditLog.create.mock.calls[0][0].data;
      expect(data.payload).toEqual({ before: null, after: { id: 'e1', startsAt: '2026-02-01T00:00:00.000Z' } });
    });
  });

  describe('list', () => {
    beforeEach(() => {
      db.auditLog.findMany.mockResolvedValue([]);
    });

    it('excludes soft-deleted rows, sorts newest first, and applies default paging', async () => {
      await service.list({ offset: 0 } as ListAuditLogsQueryDto);

      expect(db.auditLog.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: { occurredAt: 'desc' },
        skip: 0,
        take: AUDIT_LOG_DEFAULT_PAGE_SIZE,
      });
    });

    it('applies scalar filters when present', async () => {
      await service.list({
        offset: 10,
        limit: 25,
        subject: 'Event',
        subjectId: 'e1',
        actorKind: 'user',
        actorUserId: 'u1',
        event: 'event.created',
        action: 'create',
        source: 'http',
        correlationId: 'corr-1',
      } as ListAuditLogsQueryDto);

      expect(db.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          subject: 'Event',
          subjectId: 'e1',
          actorKind: 'user',
          actorUserId: 'u1',
          event: 'event.created',
          action: 'create',
          source: 'http',
          correlationId: 'corr-1',
        },
        orderBy: { occurredAt: 'desc' },
        skip: 10,
        take: 25,
      });
    });

    it('builds a half-open occurredAt range (gte from, lt to)', async () => {
      const occurredFrom = new Date('2026-01-01T00:00:00.000Z');
      const occurredTo = new Date('2026-02-01T00:00:00.000Z');

      await service.list({ offset: 0, occurredFrom, occurredTo } as ListAuditLogsQueryDto);

      const args = db.auditLog.findMany.mock.calls[0][0];
      expect(args?.where?.occurredAt).toEqual({ gte: occurredFrom, lt: occurredTo });
    });

    it('supports a one-sided range', async () => {
      const occurredFrom = new Date('2026-01-01T00:00:00.000Z');

      await service.list({ offset: 0, occurredFrom } as ListAuditLogsQueryDto);

      const args = db.auditLog.findMany.mock.calls[0][0];
      expect(args?.where?.occurredAt).toEqual({ gte: occurredFrom });
    });
  });
});
