import type { SystemActorScope } from '@bge/actor-context';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { AuditRetentionService } from './audit-retention.service';

describe('AuditRetentionService', () => {
  let db: MockDatabaseService;
  let systemActorScope: jest.Mocked<Pick<SystemActorScope, 'run'>>;
  let service: AuditRetentionService;

  const now = new Date('2026-07-01T00:00:00.000Z');

  beforeEach(() => {
    db = createMockDatabaseService();
    db.auditLog.findMany.mockResolvedValue([]);
    db.auditLog.updateMany.mockResolvedValue({ count: 0 } as never);
    systemActorScope = {
      run: jest.fn((_reason: string, fn: () => unknown) => Promise.resolve(fn())),
    } as unknown as jest.Mocked<Pick<SystemActorScope, 'run'>>;
    service = new AuditRetentionService(db as never, systemActorScope as unknown as SystemActorScope);
  });

  it('is a no-op when no settings row exists', async () => {
    db.systemSetting.findFirst.mockResolvedValue(null);

    const result = await service.runSweep(now);

    expect(result).toEqual({ softDeleted: 0 });
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when retention is null (unlimited, the default)', async () => {
    db.systemSetting.findFirst.mockResolvedValue({ auditLogRetentionDays: null } as never);

    const result = await service.runSweep(now);

    expect(result).toEqual({ softDeleted: 0 });
    expect(db.auditLog.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, -1, -30])('is a no-op (not a wipe) for non-positive retention (%s days)', async (days) => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db.systemSetting.findFirst.mockResolvedValue({ auditLogRetentionDays: days } as never);

    const result = await service.runSweep(now);

    expect(result).toEqual({ softDeleted: 0 });
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.updateMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-positive'));
    warnSpy.mockRestore();
  });

  it('soft-deletes live rows older than the retention cutoff in bounded id-batches', async () => {
    db.systemSetting.findFirst.mockResolvedValue({ auditLogRetentionDays: 30 } as never);
    db.auditLog.findMany.mockResolvedValue([{ id: 'row-1' }, { id: 'row-2' }] as never);
    db.auditLog.updateMany.mockResolvedValue({ count: 2 } as never);

    const result = await service.runSweep(now);

    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, occurredAt: { lt: new Date('2026-06-01T00:00:00.000Z') } },
      select: { id: true },
      orderBy: { occurredAt: 'asc' },
      take: 5_000,
    });
    // Re-asserts deletedAt: null so a concurrently soft-deleted row is skipped.
    expect(db.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1', 'row-2'] }, deletedAt: null },
      data: { deletedAt: now },
    });
    // A short batch means the backlog is drained — exactly one write.
    expect(db.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ softDeleted: 2 });
  });

  it('loops until the backlog drains when a batch comes back full', async () => {
    const fullBatch = Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${i}` }));
    db.systemSetting.findFirst.mockResolvedValue({ auditLogRetentionDays: 30 } as never);
    db.auditLog.findMany.mockResolvedValueOnce(fullBatch as never).mockResolvedValueOnce([{ id: 'tail' }] as never);
    db.auditLog.updateMany
      .mockResolvedValueOnce({ count: 5_000 } as never)
      .mockResolvedValueOnce({ count: 1 } as never);

    const result = await service.runSweep(now);

    expect(db.auditLog.updateMany).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ softDeleted: 5_001 });
  });

  it('runs the interval sweep inside a system actor scope', async () => {
    db.systemSetting.findFirst.mockResolvedValue({ auditLogRetentionDays: null } as never);

    await service.sweepOnInterval();

    expect(systemActorScope.run).toHaveBeenCalledWith('audit-log-retention-sweep', expect.any(Function));
    expect(db.systemSetting.findFirst).toHaveBeenCalled();
  });
});
