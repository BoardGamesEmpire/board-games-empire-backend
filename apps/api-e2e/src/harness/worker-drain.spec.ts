import { FeedbackSubmissionStatus } from '@bge/database';
import { wrapJobData } from '@bge/queue-actor-context';
import { FEEDBACK_DELIVERY_JOB, FEEDBACK_QUEUE_NAME } from '@bge/queue-feedback';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import { createFeedbackClient, freshFeedbackKey, reportPayload } from '../feedback/feedback-request';
import { LOCAL_FEEDBACK_SINK_SLUG, submitEnvelope } from '../feedback/feedback-wire';
import { requireBaseUrl } from '../support/e2e-env';
import { drainQueue, markQueueEvents } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { useWorker } from '../support/worker';

/** A slug no sink registers, so the real processor's delivery fails. */
const MISSING_SINK_SLUG = 'e2e-missing-sink';

/**
 * Acceptance for the worker child and the drain (#268): a suite opts into a
 * running worker, enqueues through the API, drains through the REAL
 * processor, and asserts post-completion state.
 *
 * The failure cases are here for the drain rather than for feedback. Its unit
 * spec scripts the events stream from a reading of BullMQ's scripts; these run
 * a real consumer, so they check that reading: that a failed delivery surfaces
 * as `failed`, and that one BullMQ will retry surfaces as a retry rather than
 * as silence until the timeout. Each failing job is added directly through the
 * test-owned queue, because the only bundled sink never fails. It carries a
 * real report, so the processor gets past the report lookup to the sink.
 *
 * Replay after a completed delivery is #348's, not this file's.
 */
describe('worker child and queue drain (#268)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { post } = createFeedbackClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  const workerQueue = useWorker();

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Submits a report and drains its real delivery, so a test starts from a delivered report. */
  async function deliveredReport(actor: SessionActor): Promise<string> {
    const queue = workerQueue(FEEDBACK_QUEUE_NAME);
    const mark = await markQueueEvents(queue);

    const response = await post(actor, reportPayload({ clientRequestId: freshFeedbackKey() })).expect(201);
    const { feedbackReport } = submitEnvelope(response, 'POST /api/feedback/reports');
    await drainQueue(queue, mark, 1);

    return feedbackReport.id;
  }

  /** Enqueues a delivery of `feedbackReportId` to a sink that does not exist. */
  async function enqueueFailingDelivery(feedbackReportId: string, attempts: number): Promise<string> {
    const jobId = `e2e-drain-${randomUUID()}`;

    await workerQueue(FEEDBACK_QUEUE_NAME).add(
      FEEDBACK_DELIVERY_JOB,
      wrapJobData(
        { feedbackReportId, sinkSlug: MISSING_SINK_SLUG },
        { actor: { kind: 'system', reason: 'e2e:worker-drain' }, correlationId: randomUUID() },
      ),
      // The backoff outlasts the file, so a retry is scheduled and never runs.
      { jobId, attempts, backoff: { type: 'fixed', delay: 60_000 } },
    );

    return jobId;
  }

  it('delivers a submission through the real processor, once', async () => {
    const actor = await actors.user();
    const feedbackReportId = await deliveredReport(actor);

    const submissions = await db.client.feedbackSubmission.findMany({
      where: { feedbackReportId },
      select: { sinkSlug: true, status: true, attempts: true },
    });

    expect(submissions).toEqual([
      { sinkSlug: LOCAL_FEEDBACK_SINK_SLUG, status: FeedbackSubmissionStatus.Submitted, attempts: 1 },
    ]);
  });

  it('fails the drain on a delivery that fails for good', async () => {
    const actor = await actors.user();
    const feedbackReportId = await deliveredReport(actor);

    const queue = workerQueue(FEEDBACK_QUEUE_NAME);
    const mark = await markQueueEvents(queue);
    const jobId = await enqueueFailingDelivery(feedbackReportId, 1);

    try {
      await expect(drainQueue(queue, mark, 1)).rejects.toThrow(
        new RegExp(`job ${jobId} failed during the drain: No feedback sink registered for slug '${MISSING_SINK_SLUG}'`),
      );
    } finally {
      // A drain that throws leaves its job behind, and nothing clears a
      // worker's queue between tests (see useWorker).
      await queue.remove(jobId);
    }
  });

  it('fails the drain on a delivery BullMQ will retry, rather than waiting out the backoff', async () => {
    const actor = await actors.user();
    const feedbackReportId = await deliveredReport(actor);

    const queue = workerQueue(FEEDBACK_QUEUE_NAME);
    const mark = await markQueueEvents(queue);
    const jobId = await enqueueFailingDelivery(feedbackReportId, 2);

    try {
      await expect(drainQueue(queue, mark, 1)).rejects.toThrow(
        new RegExp(`job ${jobId} failed an attempt and was scheduled for a retry during the drain: No feedback sink`),
      );
    } finally {
      // Otherwise the retry sits in `delayed` for its backoff, and the next
      // drain in this file fails its hold at zero on it.
      await queue.remove(jobId);
    }
  });
});
