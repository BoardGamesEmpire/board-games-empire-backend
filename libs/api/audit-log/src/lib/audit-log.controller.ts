import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { NoCache, paginated, PaginatedResponseDto } from '@bge/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuditLogEntryDto, ListAuditLogsQueryDto } from './dto';
import { AuditLogService } from './services/audit-log.service';

const PaginatedAuditLogsResponse = PaginatedResponseDto(AuditLogEntryDto, 'auditLogs');

/**
 * Read-only by design: audit rows have no mutation API. Rows are written
 * exclusively by the persistence listener and soft-deleted only by the
 * retention sweep.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('audit-logs')
@NoCache()
@UseGuards(PoliciesGuard)
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @ApiOperation({
    summary: 'List audit trail entries',
    description:
      'Newest first. Filterable by subject/subjectId, actor kind and owning user, event name, action, ' +
      'source transport, correlation id, and an occurredAt range. Paginated: `?page=` (1-based) and ' +
      '`?limit=` (default 50, max 200), with a `pagination` envelope carrying `total`, `totalPages` and ' +
      '`hasMore`; `total` counts every row matching the filters, not just this page. See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedAuditLogsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.AuditLog))
  @Get()
  list(@Query() query: ListAuditLogsQueryDto) {
    return from(this.auditLogService.list(query)).pipe(map((page) => paginated('auditLogs', page, query)));
  }
}
