import { JobType, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportJobCompletedEvent, ImportJobFailedEvent } from '../interfaces/import-job.interface';

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
      return this.logger.debug(
        `NotificationListener skipping jobId=${event.jobId} gameId=${event.gameId} ` +
          `created=${event.sourceCreated} userId=${event.userId}`,
      );
    }

    this.logger.debug(
      `NotificationListener creating notification for jobId=${event.jobId} gameId=${event.gameId} ` +
        `userId=${event.userId} isExpansion=${event.isExpansion}`,
    );

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

  /**
   * Notifies the initiating user when their import fails terminally.
   * System-initiated imports (userId = null) produce no notification.
   *
   * JobFailed fires in whichever process wins the guarded terminal
   * transition (apps/worker for import failures, apps/gateway-worker for
   * fetch failures), so this listener is registered in both modules —
   * exactly one process emits per job, so exactly one notification is
   * created.
   */
  @OnEvent(ImportEvents.JobFailed, { async: true })
  async handleFailed(event: ImportJobFailedEvent): Promise<void> {
    if (!event.userId) {
      return this.logger.debug(`NotificationListener skipping failed jobId=${event.jobId} (system-initiated)`);
    }

    try {
      await this.notifications.create({
        userId: event.userId,
        type: NotificationType.ImportFailed,
        payload: {
          // ImportFailed is shared by every import domain (game today, profile
          // sync etc. later). jobType is the generic discriminator clients key
          // copy off; the remaining fields are jobType-specific detail.
          jobType: JobType.GameImport,
          jobId: event.jobId,
          batchId: event.batchId,
          gatewayId: event.gatewayId,
          externalId: event.externalId,
          isExpansion: event.isExpansion,
          // Sanitized code + static message — the raw error can carry internal
          // hostnames/IPs, gRPC transport detail or Prisma text, so it stays in
          // Job.error / operator logs and never reaches the user's notification.
          errorCode: event.errorCode,
          error: event.error,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to create ImportFailed Notification for userId=${event.userId} jobId=${event.jobId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
