import { FEEDBACK_QUEUE_NAME } from '@bge/queue-feedback';
import type { Queue } from 'bullmq';
import { createTestQueue, obliterateQueue, waitForStableJobCount, type TestQueue } from '../support/queues';

/** Rounds of obliterate-then-hold before giving up on a queue that keeps filling. */
const DRAIN_ROUNDS = 3;

/** How long the queue must stay empty for the drain to call itself finished. */
const DRAIN_SETTLE_MS = 150;

/**
 * Empties the queue and confirms it STAYS empty, re-clearing a job that lands
 * late. Bounded rather than looping forever: if three rounds cannot leave it
 * empty, something is still producing and the caller should hear about it rather
 * than have the run hang.
 */
async function drainStrayJobs(queue: Queue): Promise<void> {
  let lastError: unknown;

  for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
    await obliterateQueue(queue);

    try {
      await waitForStableJobCount(queue, 0, { timeoutMs: 1_000, settleMs: DRAIN_SETTLE_MS });
      return;
    } catch (error) {
      // A stray landed inside the settle window — obliterate again and re-hold.
      lastError = error;
    }
  }

  throw new Error(
    `Could not leave the feedback queue empty after ${DRAIN_ROUNDS} rounds; jobs keep arriving. ` +
      `Last observation: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Registers between-test cleanup of the feedback delivery queue for one spec
 * file, and hands back an accessor for the queue itself.
 *
 * WHY EVERY FEEDBACK SPEC NEEDS THIS, not just the fan-out one. The isolation
 * sweep is database-scoped and BullMQ keys are per queue NAME, so a job outlives
 * the truncate that removed its report. Every accepted submission enqueues a
 * delivery job — which means the idempotency, authorization, and throttle specs
 * leak jobs just as readily as the file that asserts on them, even though they
 * never look at the queue.
 *
 * The failure that follows is not local. `harness.spec.ts` asserts the queue is
 * empty (#255's paused-by-default premise), so leaked jobs surface as a failure
 * in an UNRELATED file, with a count that depends on Jest's file ordering. This
 * cost a red run during implementation, at 16 leaked jobs; centralizing the
 * cleanup is what keeps the next spec author from rediscovering it.
 *
 * `resetRedis` would also clear this, and is deliberately not used: it destroys
 * the sessions these actors authenticate with. `test-isolation.ts` documents
 * that, which is why the sweep does not call it. Wiring queue reset into the
 * global sweep is #268's decision, not this suite's.
 *
 * WHY THE FILE-LEVEL DRAIN SETTLES AND THE PER-TEST ONE DOES NOT. Fan-out is
 * fire-and-forget: the listener's `queue.add` is only STARTED while the request
 * is being handled, so its Redis round-trip can finish after the response has
 * reached the test process — and therefore after a bare `afterEach` obliterate
 * has already run. A job landing in that window survives to the end of the run
 * and fails `harness.spec.ts` rather than anything here.
 *
 * The per-test obliterate stays cheap because a stray leaking from test to test
 * within this file is harmless (the next `beforeEach` clears it anyway). What
 * must be airtight is the moment the FILE finishes, so the drain in `afterAll`
 * obliterates and then holds at zero, re-obliterating anything that arrives
 * late. Paying the settle window once per file instead of once per test keeps
 * the cost at a few hundred milliseconds for the suite.
 */
export function isolateFeedbackQueue(): () => Queue {
  let handle: TestQueue | undefined;

  function requireHandle(): TestQueue {
    if (handle === undefined) {
      throw new Error('The feedback queue handle is not open yet — isolateFeedbackQueue() registers it in beforeAll');
    }

    return handle;
  }

  beforeAll(() => {
    handle = createTestQueue(FEEDBACK_QUEUE_NAME);
  });

  // Both ends, deliberately. `beforeEach` gives every test a clean baseline
  // whatever ran before it; `afterEach` is the half that stops this file leaking
  // into another one.
  beforeEach(async () => {
    await obliterateQueue(requireHandle().queue);
  });

  afterEach(async () => {
    await obliterateQueue(requireHandle().queue);
  });

  afterAll(async () => {
    try {
      if (handle !== undefined) {
        await drainStrayJobs(handle.queue);
      }
    } finally {
      // The drain throws by design when jobs keep arriving. Closing in
      // `finally` keeps that diagnostic: an unclosed ioredis socket makes Jest
      // hang or complain that a worker would not exit gracefully, which buries
      // the message the drain exists to surface.
      await handle?.close();
      handle = undefined;
    }
  });

  return () => requireHandle().queue;
}
