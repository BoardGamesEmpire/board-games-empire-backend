import { NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MediaContributionEvents } from '../constants/media-contribution-events.constant';
import type { MediaContributionRejectedEvent } from '../interfaces/media-contribution.interface';

@Injectable()
export class MediaContributionNotificationListener {
  private readonly logger = new Logger(MediaContributionNotificationListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(MediaContributionEvents.Rejected, { async: true })
  async onRejected(event: MediaContributionRejectedEvent): Promise<void> {
    try {
      await this.notifications.create({
        userId: event.contributedById,
        type: NotificationType.MediaContributionRejected,
        payload: {
          contributionId: event.contributionId,
          mediaObjectId: event.mediaObjectId,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          rejectionReason: event.rejectionReason,
          reclaimDeadline: event.reclaimDeadline,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to notify ${event.contributedById} of contribution rejection`, error);
    }
  }
}
