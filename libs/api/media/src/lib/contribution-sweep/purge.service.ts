import { DatabaseService, NotificationType, Prisma } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { StorageService } from '@bge/storage';
import { ObjectNotFoundError } from '@boardgamesempire/storage-contract';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaError } from '@status/codes';
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
    // #100 guard: dispatch filters to the active driver, but it could change
    // between dispatch and processing. Never delete from the wrong backend.
    if (job.driverSlug !== this.storage.driverSlug) {
      this.logger.warn(
        `Skipping purge of ${job.mediaObjectId}: stored on '${job.driverSlug}', active driver '${this.storage.driverSlug}' (#100)`,
      );
      return;
    }

    await this.deleteBytes(job.driverKey);

    if (await this.deleteRow(job.mediaObjectId)) {
      await this.notifyContributor(job);
    }
  }

  private async deleteBytes(driverKey: string): Promise<void> {
    try {
      await this.storage.delete(driverKey);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) {
        throw error; // already gone is fine; anything else is real
      }
    }
  }

  private async deleteRow(mediaObjectId: string): Promise<boolean> {
    try {
      await this.db.mediaObject.delete({ where: { id: mediaObjectId } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
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
