import type { ActorKind, EventSource } from '@bge/actor-context';
import { CappedPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AUDIT_LOG_MAX_PAGE_SIZE } from '../constants/audit-log.constants';

const ACTOR_KINDS = [
  'user',
  'anonymous',
  'apiKey',
  'system',
  'external',
  'plugin',
] as const satisfies readonly ActorKind[];
const EVENT_SOURCES = ['http', 'grpc', 'queue', 'ws', 'system'] as const satisfies readonly EventSource[];

/**
 * Page-size ceiling because audit tables grow without bound.
 *
 * Every scalar filter is `@IsNotEmpty()`: the service builds its `where` by
 * truthiness, so an empty-string param (`?subject=User&subjectId=`) would drop
 * that clause and silently widen the result set — a forensic-integrity hazard.
 * Rejecting `''` at the boundary makes a malformed filter fail loud (400)
 * instead of quietly returning everything. (Enum filters are already guarded by
 * `@IsIn`, which rejects `''`.)
 */
export class ListAuditLogsQueryDto extends CappedPaginationQueryDto(AUDIT_LOG_MAX_PAGE_SIZE) {
  @ApiPropertyOptional({ description: 'Filter by domain model name (ResourceType value, e.g. "Event")' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  subject?: string;

  @ApiPropertyOptional({ description: 'Filter by mutated row id (usually combined with subject)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  subjectId?: string;

  @ApiPropertyOptional({ enum: ACTOR_KINDS, description: 'Filter by actor variant' })
  @IsOptional()
  @IsIn(ACTOR_KINDS)
  actorKind?: ActorKind;

  @ApiPropertyOptional({ description: 'Filter by owning user id (plugin chains resolve to their trigger)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'Filter by raw event name (e.g. "event.created")' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  event?: string;

  @ApiPropertyOptional({
    enum: ['create', 'update', 'delete'],
    description: "Filter by mutation action ('create' | 'update' | 'delete')",
  })
  @IsOptional()
  @IsIn(['create', 'update', 'delete'])
  action?: 'create' | 'update' | 'delete';

  @ApiPropertyOptional({ enum: EVENT_SOURCES, description: 'Filter by origin transport' })
  @IsOptional()
  @IsIn(EVENT_SOURCES)
  source?: EventSource;

  @ApiPropertyOptional({ description: 'Filter by correlation id — reconstructs one request/job chain' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  correlationId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only rows that occurred at or after this time',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  occurredFrom?: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Only rows that occurred strictly before this time',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  occurredTo?: Date;
}
