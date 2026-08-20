import { FEEDBACK_DELIVERY_JOB } from '@bge/queue-feedback';
import { createActors, type Actors } from '@bge/testing-e2e';
import { requireBaseUrl } from '../support/e2e-env';
import { countPendingJobs, obliterateQueue, waitForStableJobCount } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isolateFeedbackQueue } from './feedback-queue-isolation';
import { createFeedbackClient, freshFeedbackKey, reportPayload } from './feedback-request';
import { LOCAL_FEEDBACK_SINK_SLUG, submitEnvelope } from './feedback-wire';

/**
 * #251's load-bearing claim: a replay must not re-trigger sink fan-out.
 *
 * Why this cannot be a unit test. `FeedbackService` returns early WITHOUT
 * emitting on a replay, and the unit suite asserts that by watching an emitter
 * mock. That assertion was green throughout the period the replay path was
 * unreachable — the `meta.target` discriminator matched nothing, so every keyed
 * retry rethrew and the "does not re-emit" test was proving a property of a
 * branch production never took. Asserting it over a real queue is what makes it
 * mean something.
 *
 * THE DEDUP TRAP, and why one test removes the job first. The deterministic
 * `jobId` (`feedback:<reportId>:<sinkSlug>`) dedups an `add` only while a job
 * with that id is still present. So while the original sits in `waiting`, a
 * second emission's `add` is silently swallowed by BullMQ and the pending count
 * stays at 1 — meaning a naive "still exactly one job after the replay"
 * assertion passes whether or not suppression works. It cannot fail, which
 * makes it worth almost nothing on its own.
 *
 * Removing the original's job first frees the id, which is precisely the state a
 * COMPLETED delivery leaves behind (`removeOnComplete: true`). From the
 * producer's side the two are indistinguishable: no job holds that id. So a
 * re-emit after removal WOULD create a job, and asserting zero afterwards is an
 * assertion that can actually fail.
 *
 * WHAT STILL NEEDS #348. The harness launches only `apps/api`, which registers
 * PRODUCERS only — no `@Processor` runs, so nothing here ever delivers. This
 * file proves the enqueue is suppressed; #348 proves a real worker's completed
 * delivery is not repeated, by asserting `attempts` and `externalId` on the
 * existing `FeedbackSubmission` row are unchanged. That needs a worker child
 * (#268) and the sink's `submit()` actually running.
 *
 * Queue state is not swept between tests, so cleanup is registered via
 * `isolateFeedbackQueue()` — shared with every other feedback spec,
 * because they all enqueue jobs even though only this one asserts on them.
 */
describe('feedback sink fan-out suppression on replay (#251)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { post } = createFeedbackClient(baseUrl);
  const freshKey = freshFeedbackKey;
  const report = reportPayload;

  let db: TestDatabase;
  let actors: Actors;

  const feedbackQueue = isolateFeedbackQueue();

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const submissionCountFor = (feedbackReportId: string): Promise<number> =>
    db.client.feedbackSubmission.count({ where: { feedbackReportId } });

  it('enqueues exactly one delivery job for a fresh submission', async () => {
    const actor = await actors.user();
    const response = await post(actor, report({ clientRequestId: freshKey() })).expect(201);
    const { feedbackReport } = submitEnvelope(response, 'POST /api/feedback/reports');

    // A settle window rather than a single read: fan-out is fire-and-forget, so
    // the 201 can return before `queue.add` resolves. A bare read could catch
    // the count in transit at 1 while a second add was still in flight.
    await waitForStableJobCount(feedbackQueue(), 1);

    const [job] = await feedbackQueue().getJobs(['waiting']);

    expect(job?.name).toBe(FEEDBACK_DELIVERY_JOB);
    expect(job?.data).toMatchObject({ feedbackReportId: feedbackReport.id, sinkSlug: LOCAL_FEEDBACK_SINK_SLUG });

    // The deterministic jobId IS the in-flight dedup mechanism, so it is worth
    // pinning rather than inferring from the count.
    expect(job?.id).toBe(`feedback:${feedbackReport.id}:${LOCAL_FEEDBACK_SINK_SLUG}`);

    // One job, and its slug is the bundled sink's. v1 registers exactly one
    // sink and it accepts every category, so "one job" and "one job per
    // accepting sink" are indistinguishable here — the distinction only becomes
    // observable once plugin sinks land (#59).
    await expect(countPendingJobs(feedbackQueue())).resolves.toBe(1);
  });

  it('enqueues nothing on a replay once the deterministic id is free', async () => {
    // The assertion this file exists for, in the only arrangement where it can
    // fail. See THE DEDUP TRAP above: with the original's job still in `waiting`
    // its id is taken, so a re-emit would be swallowed and any count assertion
    // would pass vacuously. Removing the job reproduces the post-delivery state
    // where the id is free, so a re-emit becomes observable as a new job.
    const actor = await actors.user();
    const clientRequestId = freshKey();
    const payload = report({ clientRequestId });

    const first = await post(actor, payload).expect(201);
    const original = submitEnvelope(first, 'POST (original)');
    await waitForStableJobCount(feedbackQueue(), 1);

    const [job] = await feedbackQueue().getJobs(['waiting']);
    if (job === undefined) {
      throw new Error('Expected the original submission to have enqueued a job before removing it');
    }
    await job.remove();
    await waitForStableJobCount(feedbackQueue(), 0, { settleMs: 100 });

    const second = await post(actor, payload).expect(201);
    expect(submitEnvelope(second, 'POST (replay)').feedbackReport.id).toBe(original.feedbackReport.id);

    // Zero, held across the settle window. A re-emitting service would have
    // enqueued a fresh `feedback:<reportId>:local` here and re-delivered the
    // report to every sink — which is the harm #251's early return prevents.
    await waitForStableJobCount(feedbackQueue(), 0);
  });

  it('adds no second job while the original is still queued', async () => {
    // Weaker than the test above BY CONSTRUCTION — while the original holds the
    // deterministic id, BullMQ would swallow a duplicate `add`, so a count that
    // stays at 1 does not prove suppression. Kept for what it does still cover:
    // that a replay adds no job under a DIFFERENT id, which is what a re-emit
    // carrying a wrong report id or an unexpected sink slug would look like.
    const actor = await actors.user();
    const payload = report({ clientRequestId: freshKey() });

    const first = await post(actor, payload).expect(201);
    const original = submitEnvelope(first, 'POST (original)');
    await waitForStableJobCount(feedbackQueue(), 1);

    await post(actor, payload).expect(201);
    await waitForStableJobCount(feedbackQueue(), 1);

    const jobs = await feedbackQueue().getJobs(['waiting']);
    expect(jobs.map((entry) => entry.id)).toEqual([
      `feedback:${original.feedbackReport.id}:${LOCAL_FEEDBACK_SINK_SLUG}`,
    ]);
  });

  it('does not resurrect a lost fan-out on replay — the report stays undeliverable (#264)', async () => {
    // CHARACTERIZATION of the residual `recoverKeyedSubmit` documents and #251
    // deliberately did not heal: if the original committed but its fan-out never
    // happened, the replay acknowledges a report no sink will ever receive, and
    // the client stops retrying because it got a 201.
    //
    // Obliterating the queue between the two requests is how a fan-out that
    // never happened is staged — the enqueue is gone, exactly as if the process
    // had died before the listener ran or every add had failed and been dropped.
    //
    // This test asserts today's behaviour and is EXPECTED TO FLIP when #264's
    // reconciliation sweep lands. That is deliberate: an unpinned known
    // limitation is the silent case, and this one is invisible from the client's
    // side by construction.
    const actor = await actors.user();
    const clientRequestId = freshKey();
    const payload = report({ clientRequestId });

    const first = await post(actor, payload).expect(201);
    const original = submitEnvelope(first, 'POST (original)');
    await waitForStableJobCount(feedbackQueue(), 1);

    await obliterateQueue(feedbackQueue());

    const second = await post(actor, payload).expect(201);

    // The ack: same id, same 201 — the client cannot tell the difference.
    expect(submitEnvelope(second, 'POST (replay after lost fan-out)').feedbackReport.id).toBe(
      original.feedbackReport.id,
    );

    // And nothing was re-enqueued to rescue it. Zero, held across the settle
    // window, is the whole finding.
    await waitForStableJobCount(feedbackQueue(), 0);

    // No sink ever recorded an attempt, so there is nothing to reconcile FROM
    // except the report row itself — which is precisely the signal #264's sweep
    // is designed to key on.
    await expect(submissionCountFor(original.feedbackReport.id)).resolves.toBe(0);
  });
});
