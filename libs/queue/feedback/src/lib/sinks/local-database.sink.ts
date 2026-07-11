import type { FeedbackReport } from '@bge/database';
import { Injectable } from '@nestjs/common';
import type { FeedbackSink, SinkSubmissionResult } from '../contract/feedback-sink';

/**
 * The bundled, always-present sink and canonical reference implementation of
 * {@link FeedbackSink}. The report is already persisted locally by the time a
 * delivery job runs, so "forwarding to local" is a no-op acknowledgement: it
 * records that the canonical copy lives in this server's database and points the
 * `FeedbackSubmission` back at the report itself.
 *
 * Accepts every category (no `acceptsCategory`), never fails, and takes no
 * dependencies — it is the floor every deployment has even with no plugins.
 */
@Injectable()
export class LocalDatabaseSink implements FeedbackSink {
  readonly slug = 'local';
  readonly bundled = true;

  async submit(report: FeedbackReport): Promise<SinkSubmissionResult> {
    // The report row IS the durable record; the external handle is the report id
    // so triage UIs can link a "local" submission back to its report.
    return { externalId: report.id, externalUrl: null };
  }
}
