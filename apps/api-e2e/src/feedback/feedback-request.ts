import { FeedbackCategory, FeedbackSeverity } from '@bge/database';
import type { SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

/**
 * Request construction shared by the feedback e2e specs.
 *
 * Four spec files submit the same endpoint, and the payload shape, the path, the
 * key generator and the minimal-valid-report builder were duplicated in each.
 * They had already diverged — only one copy declared `title` — which is the
 * failure mode worth avoiding: a wire-contract change (a renamed path, a new
 * required field) has to land in every copy or the files quietly start testing
 * different payloads.
 *
 * Request BUILDING lives here; response PARSING lives in `feedback-wire.ts`.
 */

export const FEEDBACK_REPORTS_PATH = '/api/feedback/reports';

/**
 * The wire payload for `POST /api/feedback/reports`.
 *
 * Declared here rather than imported from `CreateFeedbackReportDto`: the suite
 * is black-box, importing the DTO would pull class-validator and `@bge/i18n`
 * into the test process, and the validation specs deliberately send values a
 * DTO-typed parameter would forbid. Every field is optional and loosely typed
 * for that reason — `category` and `severity` are `string`, not their enums, so
 * a spec can post a malformed one.
 */
export interface SubmitFeedbackPayload {
  readonly category?: string;
  readonly message?: string;
  readonly severity?: string;
  readonly title?: string;
  readonly clientRequestId?: string;
}

/**
 * A valid minimal report. `Bug` requires a severity — `FeatureRequest` would
 * not — so the default carries one rather than making each caller remember.
 */
export function reportPayload(overrides: SubmitFeedbackPayload = {}): SubmitFeedbackPayload {
  return {
    category: FeedbackCategory.Bug,
    severity: FeedbackSeverity.Low,
    message: 'The dice roller returned 7 on a d6.',
    ...overrides,
  };
}

/** Random, never sequential — see `prepareSignup`'s note on issue 268. */
export function freshFeedbackKey(): string {
  return `e2e-feedback-${randomUUID()}`;
}

export interface FeedbackClient {
  /** Authenticated submission. Returns the supertest chain, so callers keep `.expect()`. */
  post(actor: SessionActor, payload: SubmitFeedbackPayload): request.Test;

  /** Unauthenticated submission, for the 401 case. */
  postAnonymous(payload: SubmitFeedbackPayload): request.Test;
}

export function createFeedbackClient(baseUrl: string): FeedbackClient {
  return {
    post: (actor, payload) => request(baseUrl).post(FEEDBACK_REPORTS_PATH).set(actor.headers).send(payload),
    postAnonymous: (payload) => request(baseUrl).post(FEEDBACK_REPORTS_PATH).send(payload),
  };
}
