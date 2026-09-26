import { ListScopeNotComposedError } from '@bge/shared';
import { plainToInstance } from 'class-transformer';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { AuditLogController } from './audit-log.controller';
import { ListAuditLogsQueryDto } from './dto';
import type { AuditLogQueryService } from './services/audit-log-query.service';

const auditQuery = (init: Partial<ListAuditLogsQueryDto> = {}) =>
  plainToInstance(ListAuditLogsQueryDto, init, { enableImplicitConversion: true });

describe('AuditLogController', () => {
  let controller: AuditLogController;
  let auditLogs: jest.Mocked<Pick<AuditLogQueryService, 'list'>>;

  beforeEach(() => {
    auditLogs = { list: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    controller = new AuditLogController(auditLogs as never);
  });

  it('forwards the query and wraps the page in the auditLogs envelope', async () => {
    auditLogs.list.mockResolvedValue({ rows: [{ id: 'a-1' }], total: 51 } as never);
    const query = auditQuery({ subject: 'Event', limit: 50 });

    const response = await firstValueFrom(controller.list(query));

    expect(auditLogs.list).toHaveBeenCalledWith(query);
    expect(response).toEqual({
      auditLogs: [{ id: 'a-1' }],
      pagination: { page: 1, limit: 50, total: 51, totalPages: 2, hasMore: true },
    });
  });

  // The service composes the `AuditLog` scope; the envelope is where the guard
  // checks for it, under the resource type the handler passes. Built inside a
  // request with nothing composed, an `AuditLog` envelope must fail. An
  // envelope declaring `Unscoped` instead would pass here, and so would one
  // passing a type still in `PENDING_SCOPE_SWEEP` — either switches the guard
  // off for this route without a sound.
  it('builds its envelope under the AuditLog scope guard', async () => {
    await expect(
      ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.list(auditQuery()))),
    ).rejects.toThrow(ListScopeNotComposedError);
  });
});
