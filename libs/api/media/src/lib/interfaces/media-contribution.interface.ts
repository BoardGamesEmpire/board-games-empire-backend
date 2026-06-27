import type { ResourceType } from '@bge/database';

export interface MediaContributionRejectedEvent {
  contributionId: string;
  mediaObjectId: string;
  contributedById: string;
  subjectType: ResourceType;
  subjectId: string;
  rejectionReason: string | null;
  reclaimDeadline: string | null;
}
