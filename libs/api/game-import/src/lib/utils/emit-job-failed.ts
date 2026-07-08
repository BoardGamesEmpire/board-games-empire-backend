import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportJobFailedEvent } from '../interfaces/import-job.interface';
import type { SanitizedImportError } from './sanitize-import-error';

/**
 * Emits the in-process JobFailed event plus the webhook-eligible
 * `game.import.failed.v1` envelope. Shared by the fetch and import
 * processors so the failure payload shape and event wiring cannot
 * diverge between the two processes.
 *
 * Call this only after winning the guarded terminal transition on the Job
 * row — both processors' failure handlers can observe the same failure
 * (deferred parent cascades), and single-emission is what lets the
 * NotificationListener run in both worker processes without duplicating
 * user notifications.
 *
 * `sanitized` must be the SAME classification already persisted to
 * Job.result by the caller (via sanitizeImportError) — computed once and
 * passed in, not recomputed here, so the webhook payload, the REST status
 * endpoint, and the in-app notification can never disagree about a job's
 * failure code/message. Every surface here carries the sanitized code +
 * static message; the raw error text lives only in the Job.error DB column
 * and operator logs (written by the caller before emitting). See
 * sanitize-import-error.ts.
 */
export function emitJobFailedEvents(
  events: EventEmitter2,
  context: Omit<ImportJobFailedEvent, 'error' | 'errorCode'>,
  sanitized: SanitizedImportError,
): void {
  events.emit(ImportEvents.JobFailed, {
    ...context,
    errorCode: sanitized.code,
    error: sanitized.message,
  } satisfies ImportJobFailedEvent);

  events.emit(
    WebhookEventType.ImportJobFailed,
    webhookEnvelope({
      subjectId: context.jobId,
      occurrenceId: context.jobId,
      data: {
        jobId: context.jobId,
        batchId: context.batchId,
        gatewayId: context.gatewayId,
        externalId: context.externalId,
        isExpansion: context.isExpansion,
        errorCode: sanitized.code,
        error: sanitized.message,
      },
    }),
  );
}
