import type { FeedbackReport, FeedbackSubmission } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Wire-contract types and fail-loud response parsers for the feedback e2e
 * suites (#262).
 *
 * The household analogue (`household/household-wire.ts`, #257) explains why
 * these are parsers rather than casts; the shared half now lives in
 * `../support/wire.ts`. What is specific here is the submit envelope, which is
 * a RECEIPT rather than a row: `FeedbackReceiptDto` deliberately exposes only
 * `id` and `createdAt` so a submission acknowledgement cannot leak server-side
 * triage state. Asserting against the full model would therefore be asserting
 * against something the endpoint does not return.
 */

export type { HttpResponseLike, RequestDescription, Wire } from '../support/wire';

export type FeedbackReportWire = Wire<FeedbackReport>;
export type FeedbackSubmissionWire = Wire<FeedbackSubmission>;

/**
 * `FeedbackReceiptDto`'s projection, derived from the model rather than
 * restated: if `id` or `createdAt` changes type in the schema, this stops
 * compiling instead of silently asserting against the wrong shape.
 */
export type FeedbackReceiptWire = Wire<Pick<FeedbackReport, 'id' | 'createdAt'>>;

export interface SubmitFeedbackEnvelope {
  readonly message: string;
  readonly feedbackReport: FeedbackReceiptWire;
}

const fail = envelopeFailure('apps/api-e2e/src/feedback/feedback-wire.ts');

/**
 * Narrows an unknown value to a feedback receipt. Both fields are checked
 * non-empty, unlike the household parser's id-only rule: the receipt has exactly
 * two fields, so validating both is the whole contract rather than a partial
 * restatement of a wide model.
 *
 * `createdAt` is length-checked for a specific reason. A serializer that
 * stringified a null Date would emit `''`, which would satisfy a bare
 * `typeof === 'string'` — and the idempotency spec's "a replay returns the
 * ORIGINAL timestamp" assertion would then compare `'' === ''` and silently
 * stop testing anything.
 */
function asReceipt(value: unknown): FeedbackReceiptWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];
  const createdAt = value['createdAt'];

  return typeof id === 'string' && id.length > 0 && typeof createdAt === 'string' && createdAt.length > 0
    ? ({ id, createdAt } satisfies FeedbackReceiptWire)
    : undefined;
}

/** `POST /api/feedback/reports`: `{ message, feedbackReport }`. */
export function submitEnvelope(response: HttpResponseLike, request: RequestDescription): SubmitFeedbackEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const feedbackReport = asReceipt(response.body['feedbackReport']);
  if (feedbackReport === undefined) {
    return fail("it carried no 'feedbackReport' object with a string id and createdAt", request, response);
  }

  const message = response.body['message'];
  if (typeof message !== 'string') {
    return fail("it carried no 'message' string", request, response);
  }

  return { message, feedbackReport };
}

/**
 * DB name of the `@@unique([userId, clientRequestId])` constraint on
 * `feedback_reports`, as mapped in
 * `prisma/models/feedback/feedback-report.prisma`.
 *
 * Inlined rather than imported from `@bge/feedback` for the reason
 * `household-wire.ts` gives for its own constraint: the suite is black-box, and
 * what is asserted is what POSTGRES reports.
 *
 * Note what is NOT here. The household module carries a long note on
 * `meta.target` because it once discriminated on it; `FeedbackService` never
 * gets the chance to — `recoverKeyedSubmit` keys replay off the presence of a
 * row under this key, which is shape-independent. The one place the P2002
 * payload shape is pinned is `apps/api-e2e/src/database/p2002-shape.spec.ts`,
 * and this suite deliberately declines to copy it here: a second probe would
 * duplicate a `@bge/database` characterization inside a feedback suite and the
 * two would drift, which is the same reason #257 moved that half out of its own
 * suite.
 */
export const FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT = 'feedback_report_user_client_request_id_unique';

/**
 * Slug of the bundled sink (`LocalDatabaseSink`), as it is written to
 * `feedback_submissions.sink_slug`.
 *
 * v1 registers this sink and no other, and it declares no `acceptsCategory`, so
 * it accepts every category — which is why the fan-out assertions in this suite
 * can only prove "exactly one job" and not "one job per accepting sink"
 * Plugin sinks (#59) are when that distinction becomes observable.
 */
export const LOCAL_FEEDBACK_SINK_SLUG = 'local';
