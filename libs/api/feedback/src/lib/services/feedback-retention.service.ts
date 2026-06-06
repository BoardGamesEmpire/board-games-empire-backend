import { Injectable, Logger } from '@nestjs/common';
import { FeedbackService } from '../feedback.service';

/**
 * Thin wrapper that the scheduled retention worker calls. Kept separate from
 * `FeedbackService` so the BullMQ job processor has a single-purpose entry
 * point and the service stays focused on per-request work.
 *
 * Wiring the BullMQ schedule itself (Repeatable job, cron expression) belongs
 * to the worker setup in the API app, not this lib — see
 * docs/FEEDBACK.md § "Retention".
 */
@Injectable()
export class FeedbackRetentionService {
  private readonly logger = new Logger(FeedbackRetentionService.name);

  constructor(private readonly feedback: FeedbackService) {}

  async runSweep(now: Date = new Date()): Promise<number> {
    this.logger.log('Running feedback retention sweep');
    const purged = await this.feedback.purgeExpired(now);

    this.logger.log(`Retention sweep complete: ${purged} report(s) purged`);

    return purged;
  }
}
