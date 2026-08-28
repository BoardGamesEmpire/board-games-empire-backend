import { ContributionOrigin, MediaContributionStatus, ResourceType, type MediaContribution } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';

export interface MediaContributionResponse {
  id: string;
  mediaObjectId: string;
  subjectType: ResourceType;
  subjectId: string;
  category: string | null;
  status: MediaContributionStatus;
  origin: ContributionOrigin;
  contributedById: string;
  reviewedById: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  reclaimDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toMediaContributionResponse(c: MediaContribution): MediaContributionResponse {
  return {
    id: c.id,
    mediaObjectId: c.mediaObjectId,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    category: c.category,
    status: c.status,
    origin: c.origin,
    contributedById: c.contributedById,
    reviewedById: c.reviewedById,
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    rejectionReason: c.rejectionReason,
    reclaimDeadline: c.reclaimDeadline?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * OpenAPI model for {@link MediaContributionResponse}. `implements` is what
 * keeps it honest: a field added to the served shape without a matching
 * property here is a compile error rather than an undocumented response field
 * (the #354 pattern).
 */
export class MediaContributionResponseDto implements MediaContributionResponse {
  @ApiProperty({ description: 'Contribution identifier' })
  id!: string;

  @ApiProperty({ description: 'The media object being contributed' })
  mediaObjectId!: string;

  @ApiProperty({ enum: ResourceType, enumName: 'ResourceType', description: 'Domain model the media attaches to' })
  subjectType!: ResourceType;

  @ApiProperty({ description: 'Id of the subject row' })
  subjectId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Caller-supplied grouping, e.g. "box-art"' })
  category!: string | null;

  @ApiProperty({ enum: MediaContributionStatus, enumName: 'MediaContributionStatus' })
  status!: MediaContributionStatus;

  @ApiProperty({ enum: ContributionOrigin, enumName: 'ContributionOrigin' })
  origin!: ContributionOrigin;

  @ApiProperty({ description: 'Who contributed it' })
  contributedById!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Reviewer, once reviewed' })
  reviewedById!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Why it was rejected' })
  rejectionReason!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Until when the contributor may reclaim it',
  })
  reclaimDeadline!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}
