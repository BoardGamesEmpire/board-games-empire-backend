import {
  DeploymentRuntime,
  FeedbackCategory,
  FeedbackContext,
  FeedbackReport,
  FeedbackSeverity,
  FeedbackStatus,
} from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Wire shape returned by the feedback API. Excludes admin-only triage detail
 * unless the requester is reading via the triage endpoints — for v1 the submit
 * endpoint returns this shape unconditionally; tightening to a user-scoped DTO
 * follows when the read endpoints land.
 */
export class FeedbackReportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  title?: string | null;

  @ApiProperty({ enum: FeedbackCategory })
  category!: FeedbackCategory;

  @ApiProperty({ enum: FeedbackContext })
  context!: FeedbackContext;

  @ApiPropertyOptional({ enum: FeedbackSeverity })
  severity?: FeedbackSeverity | null;

  @ApiProperty({ enum: FeedbackStatus })
  status!: FeedbackStatus;

  @ApiProperty({ enum: DeploymentRuntime })
  deploymentRuntime!: DeploymentRuntime;

  @ApiPropertyOptional()
  deploymentVersion?: string | null;

  @ApiProperty()
  redactionApplied!: boolean;

  @ApiProperty()
  serverRedacted!: boolean;

  @ApiProperty({ type: [String] })
  userRedactedFields!: string[];

  @ApiProperty()
  createdAt!: Date;

  static fromEntity(entity: FeedbackReport): FeedbackReportDto {
    const dto = new FeedbackReportDto();

    dto.id = entity.id;
    dto.message = entity.message;
    dto.title = entity.title;
    dto.category = entity.category;
    dto.context = entity.context;
    dto.severity = entity.severity;
    dto.status = entity.status;
    dto.deploymentRuntime = entity.deploymentRuntime;
    dto.deploymentVersion = entity.deploymentVersion;
    dto.redactionApplied = entity.redactionApplied;
    dto.serverRedacted = entity.serverRedacted;
    dto.userRedactedFields = entity.userRedactedFields;
    dto.createdAt = entity.createdAt;

    return dto;
  }
}
