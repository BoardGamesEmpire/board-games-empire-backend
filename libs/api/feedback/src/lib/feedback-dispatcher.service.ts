import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FeedbackEvents } from './constants/feedback-events.constant';
import type { FeedbackReportSubmittedEvent } from './interfaces/feedback.interface';

/**
 * Feedback dispatcher service. Subscribes to `FeedbackReportSubmitted` and fans out to
 * configured external sink drivers (GitHub, Sentry, BGE upstream, etc.).
 *
 * v1: no drivers exist; this listener is wired but no-ops. The provider lives
 * here so that adding `GithubSinkDriver` later is purely additive — no need to
 * touch the service or module wiring.
 *
 * See docs/FEEDBACK.md § "Sink drivers" for the full plan.
 */
@Injectable()
export class FeedbackDispatcherService {
  private readonly logger = new Logger(FeedbackDispatcherService.name);

  @OnEvent(FeedbackEvents.FeedbackReportSubmitted)
  async onFeedbackReportSubmitted(event: FeedbackReportSubmittedEvent): Promise<void> {
    this.logger.debug(
      `Feedback report ${event.feedbackReportId} submitted (category=${event.category}, context=${event.context}). ` +
        `No sink drivers configured; persistence-only.`,
    );
    // Future drivers fan-out here. Each driver enqueues a BullMQ job that
    // writes a FeedbackSinkDispatch row on completion. Append-only history.
  }
}
