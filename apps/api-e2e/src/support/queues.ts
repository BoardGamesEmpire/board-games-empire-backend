import { Queue } from 'bullmq';

/**
 * BullMQ helpers for e2e specs (#255).
 *
 * The suite is black-box, so queues are inspected through a TEST-OWNED
 * connection built from the same `REDIS_BULLMQ_*` environment the harness
 * pointed the API at — never by reaching into the server process.
 *
 * "Workers paused by default" holds structurally: `apps/api` registers
 * PRODUCERS only (feedback delivery, game import) — no `@Processor` runs in
 * the server, so enqueued jobs sit in `waiting` where specs can assert on
 * them deterministically. Draining through the REAL processors means
 * running the worker app and lands with #348 (split from #262); the
 * wait/obliterate primitives below are the building blocks it composes.
 */

/**
 * The slice of a BullMQ `Queue` these helpers read. Declared structurally
 * rather than as `Queue` so the unit spec can pass a plain object with no
 * cast — the same reasoning `household-wire.ts` gives for `HttpResponseLike`,
 * and the reason the waiting logic below can be tested against count
 * sequences a real queue cannot be made to produce on demand.
 */
export interface QueueLike {
  readonly name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export interface TestQueue {
  readonly queue: Queue;
  close(): Promise<void>;
}

/**
 * A queue handle on the harness's ephemeral Redis. Callers own the
 * lifecycle — an unclosed connection keeps Jest's event loop alive.
 */
export function createTestQueue(name: string, env: NodeJS.ProcessEnv = process.env): TestQueue {
  const host = env['REDIS_BULLMQ_HOST'];
  const port = Number(env['REDIS_BULLMQ_PORT']);
  const db = Number(env['REDIS_BULLMQ_DATABASE']);

  if (!host || !Number.isFinite(port) || !Number.isFinite(db)) {
    // DATABASE included: globalSetup pins it (REDIS_ENV_DATABASES), and a
    // hardcoded fallback here could silently diverge from what the API
    // child received.
    throw new Error('REDIS_BULLMQ_HOST/PORT/DATABASE are not set — did the e2e globalSetup run?');
  }

  const queue = new Queue(name, {
    connection: {
      host,
      port,
      db,
      username: env['REDIS_BULLMQ_USERNAME'] || undefined,
      password: env['REDIS_BULLMQ_PASSWORD'] || undefined,
    },
  });

  return { queue, close: (): Promise<void> => queue.close() };
}

/**
 * Jobs still owed processing: everything except completed/failed.
 *
 * `'waiting'` is deliberate and is BullMQ's PUBLIC name for this state, not a
 * typo for the Redis key. `QueueGetters.commandByType` aliases it —
 * `type = type === 'waiting' ? 'wait' : type` — and BullMQ's own `count()` and
 * `getWaitingCount()` pass `'waiting'`. `wait` is the key the list lives under;
 * `waiting` is the JobType callers hand to the API. Substituting `'wait'` here
 * has already been suggested in review once, hence this note.
 *
 * That substitution would also be actively harmful, which is the reason
 * `paused` is spelled out below. `getJobCounts` runs its arguments through
 * `sanitizeJobTypes`, which pushes `'paused'` whenever `'waiting'` is present
 * and then dedupes — so paused jobs are counted implicitly already, and listing
 * `paused` changes no count today. It earns its place by surviving the edit
 * that drops the implicit add: switch to `'wait'` and BullMQ stops volunteering
 * `paused`, silently, because the special case is keyed on the exact string
 * `'waiting'`.
 *
 * Why paused matters at all: pausing RENAMEs the `wait` list to `paused`, so a
 * paused queue holding work reports zero under `wait`. Nothing pauses the queue
 * today; the worker child that issue 348 adds has pause control as its premise.
 *
 * No double counting: a job is in exactly one of these lists, since pause moves
 * it rather than copying it, and `sanitizeJobTypes` dedupes the type list.
 */
export async function countPendingJobs(queue: QueueLike): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'paused', 'active', 'delayed', 'prioritized', 'waiting-children');
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export interface WaitForQueueEmptyOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Polls until the queue holds no pending jobs. Only useful once something
 * is consuming — with no worker attached (this suite's default), a
 * non-empty queue never drains and this rejects at the timeout, naming the
 * count so the failure is diagnosable.
 */
export async function waitForQueueEmpty(queue: Queue, options: WaitForQueueEmptyOptions = {}): Promise<void> {
  const { timeoutMs = 10_000, pollIntervalMs = 50 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const pending = await countPendingJobs(queue);
    if (pending === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Queue '${queue.name}' still has ${pending} pending job(s) after ${timeoutMs}ms`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface WaitForStableJobCountOptions {
  /** Budget for the count to REACH the expected value. */
  readonly timeoutMs?: number;

  /** How long it must then HOLD at that value. */
  readonly settleMs?: number;

  readonly pollIntervalMs?: number;
}

/**
 * Waits for the pending count to reach `expected`, then requires it to STAY
 * there for `settleMs` (#262).
 *
 * Why a settle window rather than a single read. Fan-out is fire-and-forget:
 * `EventEmitter2.emit` dispatches the async `@OnEvent` listener without
 * awaiting it, so a submission's HTTP response can return before
 * `queue.add` resolves. That makes every job assertion in this suite a race,
 * in both directions:
 *
 * - A POSITIVE assertion ("one job was enqueued") can catch the count in
 *   transit at 1 while a second add is still in flight, so a double-enqueue
 *   defect passes.
 * - A NEGATIVE assertion ("a replay enqueued nothing") has no event to wait
 *   for at all. Polling cannot prove an absence; only a window can.
 *
 * One function covers both because the negative case is just `expected: 0`,
 * where the arrival check passes immediately and the whole budget is the
 * settle window. Any deviation from `expected` once it has been reached is a
 * failure, which is what catches the second job in the positive case.
 *
 * A fixed `sleep` was rejected: it is the same window with no assertion that
 * the count held, so it fails only when the timing happens to be unlucky.
 *
 * HONEST LIMIT: `settleMs` is a bound on how long a late enqueue may take,
 * not a proof that none is coming. It is chosen to be generous next to the
 * sub-millisecond gap between the insert committing and the listener's
 * `add`, but a settle window that passes on a badly overloaded machine is a
 * false negative rather than a guarantee. Widening it is cheap; removing the
 * assumption needs the emitter to be awaited, which is product surface this
 * suite does not own.
 */
export async function waitForStableJobCount(
  queue: QueueLike,
  expected: number,
  options: WaitForStableJobCountOptions = {},
): Promise<void> {
  const { timeoutMs = 10_000, settleMs = 500, pollIntervalMs = 50 } = options;

  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`waitForStableJobCount: expected count must be >= 0 and an integer, got ${expected}`);
  }

  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + timeoutMs;
  let observed = await countPendingJobs(queue);

  while (observed !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Queue '${queue.name}' never reached ${expected} pending job(s) within ${timeoutMs}ms; last saw ${observed}`,
      );
    }

    await sleep(pollIntervalMs);
    observed = await countPendingJobs(queue);
  }

  const settleUntil = Date.now() + settleMs;

  while (Date.now() < settleUntil) {
    await sleep(pollIntervalMs);
    observed = await countPendingJobs(queue);

    if (observed !== expected) {
      throw new Error(
        `Queue '${queue.name}' reached ${expected} pending job(s) but then moved to ${observed} ` +
          `within the ${settleMs}ms settle window. For an expected 0 this means something WAS enqueued; ` +
          `for a positive expectation it means more jobs arrived than the assertion allows.`,
      );
    }
  }
}

/** Removes every job (any state) from the queue. */
export async function obliterateQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
