import type { ResourceType } from '@bge/database';

/** Self-contained purge payload. Carries everything the processor needs — the
 *  row delete cascades the contribution away, so the data for the notification
 *  must travel on the job, not be re-read afterwards. */
export interface PurgeContributionJob {
  contributionId: string;
  mediaObjectId: string;
  driverKey: string;
  driverSlug: string;
  contributedById: string;
  subjectType: ResourceType;
  subjectId: string;
}
