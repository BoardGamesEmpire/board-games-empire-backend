import type { ContributionOrigin, MediaContribution, MediaContributionStatus, ResourceType } from '@bge/database';

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
