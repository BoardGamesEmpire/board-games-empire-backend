import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Wire-format log level for a `Breadcrumb`. Values are camelCase to match
 * the client's `BgeLogLevel.toWire()` output exactly. This intentionally
 * diverges from the backend's PascalCase enum convention because the enum
 * is client-authored — see the Dart docstring on `BgeLogLevel` in
 * `packages/core/observability/lib/src/logging/bge_log_level.dart`.
 */
export enum BreadcrumbLogLevel {
  Verbose = 'verbose',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/**
 * One sanitized log record carried alongside a `CreateFeedbackReportDto`.
 *
 * Mirrors the client `Breadcrumb` from
 * `packages/core/observability/lib/src/breadcrumbs/breadcrumb.dart`. Email
 * masking on `message` and key-based redaction on `sanitizedContext` are
 * performed client-side at *capture* time — by the time a breadcrumb
 * reaches this DTO, it is already scrubbed. The backend only enforces
 * structural correctness; aggregate size is capped on the parent array via
 * `@MaxJsonBytes(FEEDBACK_BREADCRUMBS_MAX_BYTES)`.
 *
 * Stack traces are NOT carried here — crash traces compose into the
 * `message` field via `composeCrashMessage` until a dedicated column
 * lands.
 */
export class BreadcrumbDto {
  @ApiProperty({
    description: 'When the underlying log record was emitted (ISO 8601, UTC).',
    example: '2026-06-13T10:00:00.000Z',
  })
  @IsISO8601()
  timestamp!: string;

  @ApiProperty({
    enum: BreadcrumbLogLevel,
    description: 'Client log level, collapsed onto the five-level BGE scheme. camelCase wire form.',
  })
  @IsEnum(BreadcrumbLogLevel)
  level!: BreadcrumbLogLevel;

  @ApiProperty({
    description: 'Dotted hierarchical logger name (e.g. "bge.storage.sync_queue").',
    example: 'bge.storage.sync_queue',
  })
  @IsString()
  @IsNotEmpty()
  loggerName!: string;

  @ApiProperty({
    description: 'Log message, post client-side email-pattern masking.',
  })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiPropertyOptional({
    description: 'Structured log context, post client-side key-based redaction. Nullable per Dart wire form.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  sanitizedContext?: Record<string, unknown> | null;
}
