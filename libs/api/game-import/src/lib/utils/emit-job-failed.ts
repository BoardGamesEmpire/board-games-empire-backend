import { JobStatus } from '@bge/database';
import { WebhookEventType, webhookEnvelope } from '@bge/webhooks';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { ImportJobFailedEvent, type ImportJobEventContext } from '../events/import.events';
import type { SanitizedImportError } from './sanitize-import-error';

/** Identifies the failed Job row plus the listener-facing context fields. */
export interface JobFailureContext extends ImportJobEventContext {
  jobId: string;
}

/**
 * Emits the in-process `ImportJobFailedEvent` plus the webhook-eligible
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
 * The acting actor / correlationId ride CLS (both callers invoke this inside
 * `runInActorScope`), never the payload. `initiatedAt` is captured by the
 * caller at the start of its terminal-failure unit of work.
 *
 * `sanitized` must be the SAME classification already persisted to
 * Job.result by the caller (via sanitizeImportError) — computed once and
 * passed in, not recomputed here, so the audit row, the webhook payload,
 * the REST status endpoint, and the in-app notification can never disagree
 * about a job's failure code/message. Every surface here carries the
 * sanitized code + static message; the raw error text lives only in the
 * Job.error DB column and operator logs (written by the caller before
 * emitting). See sanitize-import-error.ts.
 */
export function emitJobFailedEvents(
  events: EventEmitter2,
  context: JobFailureContext,
  sanitized: SanitizedImportError,
  initiatedAt: Date,
): void {
  const { jobId, batchId, gatewayId, externalId, isExpansion } = context;

  events.emit(
    ImportJobFailedEvent.eventName,
    new ImportJobFailedEvent(
      // Both callers guard on status ∈ [Pending, Running] without reading the
      // row back, so the prior status is unknown here. Record only the row
      // identity rather than fabricating a transition — `action` still
      // derives as 'update' (both sides non-null).
      { id: jobId },
      {
        id: jobId,
        status: JobStatus.Failed,
        result: { errorCode: sanitized.code, error: sanitized.message },
      },
      { batchId, gatewayId, externalId, isExpansion },
      initiatedAt,
    ),
  );

  events.emit(
    WebhookEventType.ImportJobFailed,
    webhookEnvelope({
      subjectId: jobId,
      occurrenceId: jobId,
      data: {
        jobId,
        batchId,
        gatewayId,
        externalId,
        isExpansion,
        errorCode: sanitized.code,
        error: sanitized.message,
      },
    }),
  );
}
