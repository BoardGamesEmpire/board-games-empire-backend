import { DatabaseService, isPrismaDependentRecordNotFoundError, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { StorageService } from '@bge/storage';
import type { StorageLocator } from '@boardgamesempire/storage-contract';
import { ObjectNotFoundError } from '@boardgamesempire/storage-contract';
import { Injectable, Logger } from '@nestjs/common';
import type { PurgeContributionJob } from '../interfaces/purge-contribution-job.interface';

@Injectable()
export class MediaContributionPurgeService {
  private readonly logger = new Logger(MediaContributionPurgeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Deletes the bytes + MediaObject row (which cascades the contribution), then
   * best-effort notifies the original contributor. Idempotent: tolerates
   * already-gone bytes (ObjectNotFound) and rows (P2025). Notify is best-effort
   * and gated on *this* run having deleted the row, so neither a retry nor a
   * concurrent runner double-notifies.
   */
  async purge(job: PurgeContributionJob): Promise<void> {
    await this.deleteBytes({ driverSlug: job.driverSlug, driverKey: job.driverKey });

    if (await this.deleteRow(job.mediaObjectId)) {
      await this.notifyContributor(job);
    }
  }

  private async deleteBytes(locator: StorageLocator): Promise<void> {
    try {
      await this.storage.delete(locator);
    } catch (error) {
      // Already-gone bytes are fine. Anything else — including an unregistered
      // driver (#100) — propagates so BullMQ retries and ultimately parks the job.
      if (!(error instanceof ObjectNotFoundError)) {
        throw error;
      }
    }
  }

  private async deleteRow(mediaObjectId: string): Promise<boolean> {
    try {
      await this.db.mediaObject.delete({ where: { id: mediaObjectId } });
      return true;
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        return false; // another runner won the race — don't notify twice
      }
      throw error;
    }
  }

  private async notifyContributor(job: PurgeContributionJob): Promise<void> {
    try {
      await this.notifications.create({
        userId: job.contributedById,
        type: NotificationType.MediaContributionReclaimExpired,
        payload: {
          contributionId: job.contributionId,
          mediaObjectId: job.mediaObjectId,
          subjectType: job.subjectType,
          subjectId: job.subjectId,
        },
      });
    } catch (error) {
      this.logger.error(`Purged ${job.mediaObjectId} but failed to notify ${job.contributedById}`, error);
    }
  }
}
