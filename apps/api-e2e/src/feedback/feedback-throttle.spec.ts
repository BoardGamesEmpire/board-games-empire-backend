import { createActors, type Actors } from '@bge/testing-e2e';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isolateFeedbackQueue } from './feedback-queue-isolation';
import { createFeedbackClient, freshFeedbackKey, reportPayload } from './feedback-request';
import { submitEnvelope } from './feedback-wire';

/** Mirrors `FEEDBACK_USER_THROTTLE_LIMIT`; inlined per the black-box rule. */
const USER_THROTTLE_LIMIT = 30;

/**
 * Issue 251's rate-limit claim: a replay CONSUMES throttle budget, and the response when the budget
 * runs out is a 429 rather than a 500.
 *
 * Both halves matter to a client. The first says an idempotency key is not a
 * licence to retry without limit — the short-circuit saves the database write,
 * not the request. The second is the difference between a retryable answer and
 * the failure #251 fixed: a 500 on a legitimate retry is what the whole feature
 * exists to prevent, and a rate limiter that produced one would reintroduce it
 * under a different name.
 *
 * WHY THE PER-USER TIER, NOT THE IP TIER. The route carries its own
 * `@Throttle({ default })`, which REPLACES the app-wide IP tier, so the
 * harness's `API_THROTTLE_LIMIT` pin does not raise its ceiling — it stays at
 * 100/IP/hour, and every request in this app comes from `127.0.0.1`. Tripping
 * that tier would spend the run's entire feedback budget and put every later
 * feedback POST — in this file and in every other — behind a 429 unrelated to
 * what it asserts. The per-user tier (30) is keyed on the user id, so a
 * throwaway actor confines the damage to a key nothing else uses.
 *
 * It also keeps #341 out of the way: its block-reset defect clears pending
 * decrements for every key under a throttler NAME, and the two tiers are
 * separately named (`user` and `default`), so a trip here cannot slow the decay
 * of keys the rest of the suite depends on.
 *
 * THE COST, STATED PLAINLY. This file spends ~31 of the run's ~100 IP-tier
 * submissions, because the user limit is a compile-time constant that cannot be
 * lowered for tests (#343). Buckets are in-process in a child that outlives the
 * truncate sweep, and `blockDuration` defaults to the ttl — so exceeding the IP
 * tier would block the route for a wall-clock HOUR against a suite that runs in
 * under a minute. There is headroom today; there is not much. Adding feedback
 * specs without #343 is how that headroom disappears.
 */
describe('feedback submission throttling (#251)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { post } = createFeedbackClient(baseUrl);
  const freshKey = freshFeedbackKey;
  const report = reportPayload;

  let db: TestDatabase;
  let actors: Actors;

  // Every accepted submission here enqueues a delivery job. This file never
  // looks at the queue, but a job it leaves behind fails `harness.spec.ts`.
  isolateFeedbackQueue();

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  it('counts replays against the per-user budget and answers 429, not 500', async () => {
    // A dedicated actor, used for nothing else: it ends this test blocked for an
    // hour of wall clock, which is fine only because nothing addresses it again.
    const actor = await actors.user();
    const clientRequestId = freshKey();
    const payload = report({ clientRequestId });

    // Sequential, not `Promise.all`: the counter increments per request, and a
    // concurrent burst would make WHICH request trips the limit non-deterministic.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < USER_THROTTLE_LIMIT; attempt += 1) {
      const response = await post(actor, payload);
      statuses.push(response.status);
    }

    // Every request up to the limit succeeds — and all but the first are replays,
    // which is the point: the short-circuit does not make them free.
    expect(statuses).toEqual(Array.from({ length: USER_THROTTLE_LIMIT }, () => 201));

    const overLimit = await post(actor, payload);

    // 429, and specifically not 500. Asserted on the status rather than the body:
    // `I18nValidationExceptionFilter` runs with `detailedErrors: false`, so the
    // message shape is presentation this spec should not couple to.
    expect(overLimit.status).toBe(429);

    // And the budget was spent on requests that wrote nothing. One row for 30
    // accepted submissions is the replay short-circuit working exactly as #251
    // specified, while the rate limiter counted every attempt.
    await expect(db.client.feedbackReport.count({ where: { userId: actor.user.id } })).resolves.toBe(1);
  });

  it('leaves a different user unthrottled — the tier is keyed per user', async () => {
    // The control for the test above: without it, a bug that blocked the ROUTE
    // rather than the user would look identical. Also proves the trip did not
    // leak onto the IP tier's bucket, which every other feedback spec shares.
    const other = await actors.user();

    const response = await post(other, report({ clientRequestId: freshKey() })).expect(201);

    expect(submitEnvelope(response, 'POST /api/feedback/reports').feedbackReport.id).toBeTruthy();
  });
});
