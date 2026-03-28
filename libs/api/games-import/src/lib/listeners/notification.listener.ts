import { NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportJobCompletedEvent } from '../interfaces/import-job.interface';

/**
 * Creates a Notification for the importing user when a new game or expansion
 * is added to the system for the first time.
 *
 * Skipped when:
 *   - created = false (re-import / enrichment update — no new content)
 *   - userId = null (system-initiated import — no user to notify)
 */
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(ImportEvents.JobCompleted, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    if (!event.sourceCreated || !event.userId) {
      return;
    }

    try {
      await this.notifications.create({
        userId: event.userId,
        type: event.isExpansion ? NotificationType.ExpansionImported : NotificationType.GameImported,
        payload: {
          gameId: event.gameId,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
          jobId: event.jobId,
          batchId: event.batchId,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to create Notification for userId=${event.userId} gameId=${event.gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
