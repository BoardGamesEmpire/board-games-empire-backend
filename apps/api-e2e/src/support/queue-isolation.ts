import type { Queue } from 'bullmq';
import { countPendingJobs, createTestQueue, obliterateQueue, waitForStableJobCount, type TestQueue } from './queues';
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
 * Per queue, how many of the drains this spec file registered are still to
 * run. `isolateQueue` and `useWorker` register theirs as they register their
 * hooks, and record each one as run at the end of its `afterAll`.
 * `checkLeftoverJobs` leaves a queue to a drain still to come. Module state, and
 * so one registry per file: Jest gives each spec file a module registry of its
 * own, and loads the setup files into it.
 *
 * Why `checkLeftoverJobs` can't simply count after the drain: jest-circus runs
 * a block's `afterAll` hooks in the order they were declared, and the setup file
 * registers the check first. In a spec that installs one of these helpers at its
 * top level, the drain therefore runs after the check, which would fail the file
 * for a late job the drain was about to remove.
 *
 * Why only while the drain is still to come: a helper installed inside a
 * describe has drained by the time the check runs, since a describe's
 * `afterAll` hooks finish before the root's start. The check then counts what
 * the file left after the drain, such as jobs a later describe added without
 * isolating the queue.
 */
const drainsToRun = new Map<string, number>();

/**
 * Registers a drain this spec file will run in an `afterAll`, emptying the
 * named queues, and returns the call that records it as run.
 */
export function registerDrain(...names: readonly string[]): () => void {
  for (const name of names) {
    drainsToRun.set(name, (drainsToRun.get(name) ?? 0) + 1);
  }

  return () => {
    for (const name of names) {
      drainsToRun.set(name, (drainsToRun.get(name) ?? 0) - 1);
    }
  };
}

/** Whether a drain this spec file registered for the queue is still to run. */
export function hasDrainToRun(name: string): boolean {
  return (drainsToRun.get(name) ?? 0) > 0;
}

/**
 * The verdict {@link checkLeftoverJobs} reaches when a file finishes: throws
 * when the file left more jobs pending on the queue than it found. Exported so
 * the verdict can be unit-tested without registering hooks.
 */
export function requireNoLeftoverJobs(name: string, pendingAtStart: number, pendingAtEnd: number): void {
  if (pendingAtEnd <= pendingAtStart) {
    return;
  }

  throw new Error(
    `This file left ${pendingAtEnd - pendingAtStart} job(s) pending on the '${name}' queue ` +
      `(${pendingAtStart} when it started, ${pendingAtEnd} when it finished). Nothing consumes the queue, ` +
      `so they outlive the file. A file that fills a queue installs isolateQueue('${name}'), even if it ` +
      `never looks at the queue.`,
  );
}

/**
 * Registers, for one spec file, the check that it leaves the queue no fuller
 * than it found it (#684). A file that fills the queue without `isolateQueue`
 * then fails itself, whatever its order or shard. The count runs from the
 * file's own start rather than from zero, so the files after a leak don't
 * fail with it. While a drain the file registered for the queue is still to
 * run, the queue is left to that drain (see {@link drainsToRun}).
 *
 * One read at the end, with no settle window: the drain must clear every late
 * job, but the check only has to see one. The API writes a submission's first
 * job to Redis before it writes the response, since `emit` runs the fan-out
 * listener in place and, on a live connection, `queue.add` waits on no I/O
 * before its write. Jobs for further sinks can still be in flight, but one is
 * enough to fail the file.
 *
 * That order is a margin, not a proof: this read uses a connection of its own,
 * and Redis runs commands in the order they arrive, whatever connection
 * carries them. To be missed, the job's command would have to stay in transit
 * longer than the response's trip, the rest of the test and the hooks before
 * this read. A settle window would only widen that margin, at a cost to every
 * file the check runs in.
 *
 * `test-isolation.ts` calls it, so every spec file runs it. It only reads the
 * queue, so unlike `isolateQueue` it needs no Redis ownership guard.
 */
export function checkLeftoverJobs(name: string): void {
  let handle: TestQueue | undefined;
  let pendingAtStart: number | undefined;

  beforeAll(async () => {
    handle = createTestQueue(name);
    pendingAtStart = await countPendingJobs(handle.queue);
  });

  afterAll(async () => {
    try {
      if (handle !== undefined && pendingAtStart !== undefined && !hasDrainToRun(name)) {
        requireNoLeftoverJobs(name, pendingAtStart, await countPendingJobs(handle.queue));
      }
    } finally {
      await handle?.close();
      handle = undefined;
      pendingAtStart = undefined;
    }
  });
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
 * For the feedback queue that is enforced: `checkLeftoverJobs` fails a file
 * that leaves jobs there without this. Other queues have no such check, and
 * their leftovers stay for every file that follows. Centralizing the cleanup
 * keeps each spec author from rediscovering this; it cost a red run while the
 * feedback suite (#262) was written, at 16 leaked jobs.
 *
 * WHY THE FILE-LEVEL DRAIN SETTLES AND THE PER-TEST ONE DOES NOT. Fan-out is
 * fire-and-forget: the listener's `queue.add` is only STARTED while the request
 * is being handled, so its Redis round-trip can finish after the response has
 * reached the test process — and therefore after a bare `afterEach` obliterate
 * has already run. A job landing in that window survives the test, and after
 * the file's last test only the drain below removes it.
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
  const drainRan = registerDrain(name);

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
      drainRan();

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
