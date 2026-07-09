import { actorUserId, AuditContextService } from '@bge/actor-context';
import { JobType, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportJobCompletedEvent, ImportJobFailedEvent } from '../events/import.events';

/**
 * Creates a Notification for the importing user when a new game or expansion
 * is added to the system for the first time.
 *
 * The importing user is derived from the CLS actor (restored per BullMQ job
 * by ActorAwareWorkerHost and propagated through EventEmitter2), never from
 * the event payload.
 *
 * Skipped when:
 *   - created = false (re-import / enrichment update — no new content)
 *   - no user behind the actor (system/external-initiated import — no user to notify)
 */
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly auditContext: AuditContextService,
  ) {}

  @OnEvent(ImportJobCompletedEvent.eventName, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    const { gameId } = event.after;
    const userId = this.requestingUserId();

    if (!event.sourceCreated || !userId) {
      return this.logger.debug(
        `NotificationListener skipping jobId=${event.subjectId} gameId=${gameId} ` +
          `created=${event.sourceCreated} userId=${userId}`,
      );
    }

    this.logger.debug(
      `NotificationListener creating notification for jobId=${event.subjectId} gameId=${gameId} ` +
        `userId=${userId} isExpansion=${event.isExpansion}`,
    );

    try {
      await this.notifications.create({
        userId,
        type: event.isExpansion ? NotificationType.ExpansionImported : NotificationType.GameImported,
        payload: {
          gameId,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
          jobId: event.subjectId,
          batchId: event.batchId,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to create Notification for userId=${userId} gameId=${gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Notifies the initiating user when their import fails terminally.
   * System-initiated imports (no user behind the CLS actor) produce no
   * notification.
   *
   * JobFailed fires in whichever process wins the guarded terminal
   * transition (apps/worker for import failures, apps/gateway-worker for
   * fetch failures), so this listener is registered in both modules —
   * exactly one process emits per job, so exactly one notification is
   * created.
   */
  @OnEvent(ImportJobFailedEvent.eventName, { async: true })
  async handleFailed(event: ImportJobFailedEvent): Promise<void> {
    const userId = this.requestingUserId();

    if (!userId) {
      return this.logger.debug(`NotificationListener skipping failed jobId=${event.subjectId} (system-initiated)`);
    }

    try {
      await this.notifications.create({
        userId,
        type: NotificationType.ImportFailed,
        payload: {
          // ImportFailed is shared by every import domain (game today, profile
          // sync etc. later). jobType is the generic discriminator clients key
          // copy off; the remaining fields are jobType-specific detail.
          jobType: JobType.GameImport,
          jobId: event.subjectId,
          batchId: event.batchId,
          gatewayId: event.gatewayId,
          externalId: event.externalId,
          isExpansion: event.isExpansion,
          // Sanitized code + static message from the persisted Job.result
          // snapshot — the raw error can carry internal hostnames/IPs, gRPC
          // transport detail or Prisma text, so it stays in Job.error /
          // operator logs and never reaches the user's notification.
          errorCode: event.after.result.errorCode,
          error: event.after.result.error,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to create ImportFailed Notification for userId=${userId} jobId=${event.subjectId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Requesting user from the CLS actor — null when the import was initiated
   * by a system/external actor (preserving the old `userId: string | null`
   * payload semantics).
   */
  private requestingUserId(): string | null {
    const actor = this.auditContext.getActor();
    return actor ? actorUserId(actor) : null;
  }
}
