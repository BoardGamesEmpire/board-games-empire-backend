import type { Queue } from 'bullmq';
import { createTestQueue, obliterateQueue, waitForStableJobCount, type TestQueue } from './queues';
import { requireDisposableRedis } from './redis-reset';

/** Rounds of obliterate-then-hold before giving up on a queue that keeps filling. */
const EMPTY_ROUNDS = 3;

/** How long the queue must stay empty for the drain to call itself finished. */
const EMPTY_SETTLE_MS = 150;

/**
 * Empties the queue and confirms it STAYS empty, re-clearing a job that lands
 * late. Bounded rather than looping forever: if three rounds cannot leave it
 * empty, something is still producing and the caller should hear about it rather
 * than have the run hang.
 *
 * One state it cannot clear: flow parents waiting on their children
 * (`waiting-children`). BullMQ's obliterate leaves that set alone, while
 * `countPendingJobs` counts it, so a queue holding one fails here as if jobs
 * kept arriving. No e2e spec creates a flow today; the game import is the one
 * producer that would.
 *
 * Callers check the Redis ownership guard first; this assumes it passed.
 */
export async function emptyQueue(queue: Queue): Promise<void> {
  let lastError: unknown;

  for (let round = 0; round < EMPTY_ROUNDS; round += 1) {
    await obliterateQueue(queue);

    try {
      await waitForStableJobCount(queue, 0, { timeoutMs: 1_000, settleMs: EMPTY_SETTLE_MS });
      return;
    } catch (error) {
      // A stray landed inside the settle window — obliterate again and re-hold.
      lastError = error;
    }
  }

  throw new Error(
    `Could not leave the '${queue.name}' queue empty after ${EMPTY_ROUNDS} rounds; jobs keep arriving. ` +
      `Last observation: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * The guarded open behind {@link isolateQueue}'s `beforeAll`: refuses a Redis
 * nobody marked disposable before any connection exists, then opens the
 * test-owned handle. Exported so the refusal can be unit-tested without
 * registering hooks.
 */
export function openIsolatedQueue(name: string, env: NodeJS.ProcessEnv = process.env): TestQueue {
  requireDisposableRedis(`obliterate the '${name}' queue`, env);
  return createTestQueue(name, env);
}

/**
 * Registers between-test cleanup of one queue for one spec file, and hands back
 * an accessor for the queue itself. A file that fills several queues calls it
 * once per queue.
 *
 * WHY A FILE THAT NEVER LOOKS AT THE QUEUE STILL NEEDS THIS. The isolation
 * sweep is database-scoped and BullMQ keys are per queue NAME, so a job outlives
 * the truncate that removed its row. Every accepted feedback submission enqueues
 * a delivery job, which means the idempotency, authorization, and throttle specs
 * leak jobs just as readily as the file that asserts on them.
 *
 * The failure that follows is not local. `harness.spec.ts` asserts the feedback
 * queue is empty (the no-consumer baseline), so leaked jobs surface as a failure
 * in an UNRELATED file, with a count that depends on Jest's file ordering. This
 * cost a red run while the feedback suite (#262) was written, at 16 leaked jobs;
 * centralizing the cleanup is what keeps the next spec author from rediscovering
 * it.
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
 *
 * GUARDED. `beforeAll` refuses, by throwing, a Redis the harness did not
 * provision unless `BGE_E2E_REDIS_FLUSH_OK=true` says it is disposable (see
 * `requireDisposableRedis`).
 *
 * NOT FOR A QUEUE `useWorker` CONSUMES. The per-test obliterate is forced, so
 * with a worker attached it would remove a job the worker is holding. In a
 * worker file, `drainQueue` is what leaves a consumed queue empty between tests,
 * and `useWorker` empties its queues itself before launch and after stop.
 */
export function isolateQueue(name: string): () => Queue {
  let handle: TestQueue | undefined;

  function requireHandle(): TestQueue {
    if (handle === undefined) {
      throw new Error(`The '${name}' queue handle is not open yet — isolateQueue() registers it in beforeAll`);
    }

    return handle;
  }

  beforeAll(() => {
    handle = openIsolatedQueue(name);
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
        await emptyQueue(handle.queue);
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
