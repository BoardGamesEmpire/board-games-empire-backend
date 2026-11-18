import type { ResourceType } from '@bge/database';

export interface MediaContributionRejectedEvent {
  contributedById: string;
  contributionId: string;
  mediaObjectId: string;
  reclaimDeadline: string | null;
  rejectionReason: string | null;
  subjectId: string;
  subjectType: ResourceType;
}
