import { Queue, type RedisOptions } from 'bullmq';
import { redisTlsOptions } from './redis-reset';

/**
 * BullMQ helpers for e2e specs (#255).
 *
 * The suite is black-box, so queues are inspected through a TEST-OWNED
 * connection built from the same `REDIS_BULLMQ_*` environment the harness
 * pointed the API at — never by reaching into the server process.
 *
 * The baseline is NO CONSUMER BY DEFAULT, and it holds structurally:
 * `apps/api` registers PRODUCERS only (feedback delivery, game import) — no
 * `@Processor` runs in the server, so enqueued jobs sit in `waiting` where
 * specs can assert on them deterministically. Nothing pauses a queue to get
 * there, and nothing should: `obliterate` deletes the key a pause is stored in
 * (#268).
 *
 * A spec that needs the REAL processors installs `useWorker()`, which runs
 * `apps/worker` beside the API for that file, and waits with `drainQueue`.
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
 * The connection the test-owned queue handles use, from the same
 * `REDIS_BULLMQ_*` variables the API and worker children read. TLS included:
 * on a `rediss://` escape hatch a plaintext handle would retry forever beside
 * a worker that had connected.
 */
export function testQueueConnection(env: NodeJS.ProcessEnv = process.env): RedisOptions {
  const host = env['REDIS_BULLMQ_HOST'];
  const port = Number(env['REDIS_BULLMQ_PORT']);
  const db = Number(env['REDIS_BULLMQ_DATABASE']);

  if (!host || !Number.isFinite(port) || !Number.isFinite(db)) {
    // DATABASE included: globalSetup pins it (REDIS_ENV_DATABASES), and a
    // hardcoded fallback here could silently diverge from what the API
    // child received.
    throw new Error('REDIS_BULLMQ_HOST/PORT/DATABASE are not set — did the e2e globalSetup run?');
  }

  return {
    host,
    port,
    db,
    username: env['REDIS_BULLMQ_USERNAME'] || undefined,
    password: env['REDIS_BULLMQ_PASSWORD'] || undefined,
    ...redisTlsOptions(env, 'REDIS_BULLMQ_'),
  };
}

/**
 * A queue handle on the harness's ephemeral Redis. Callers own the
 * lifecycle — an unclosed connection keeps Jest's event loop alive.
 */
export function createTestQueue(name: string, env: NodeJS.ProcessEnv = process.env): TestQueue {
  const queue = new Queue(name, { connection: testQueueConnection(env) });

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
 * paused queue holding work reports zero under `wait`. Nothing in the suite
 * pauses a queue (see the note at the top of this file), so this is insurance
 * against one that someone pauses by hand.
 *
 * No double counting: a job is in exactly one of these lists, since pause moves
 * it rather than copying it, and `sanitizeJobTypes` dedupes the type list.
 */
export async function countPendingJobs(queue: QueueLike): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'paused', 'active', 'delayed', 'prioritized', 'waiting-children');
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
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

type StreamEntry = [id: string, fields: string[]];

/**
 * The two stream reads the drain makes, as a structural slice of the
 * connection a BullMQ `Queue` exposes (`queue.client`). Declared for the same
 * reason as {@link QueueLike}: the unit spec scripts event sequences a real
 * queue cannot be made to produce on demand.
 */
export interface EventStreamReader {
  xrange(key: string, start: string, end: string): Promise<StreamEntry[]>;
  xrevrange(key: string, end: string, start: string, countToken: 'COUNT', count: number): Promise<StreamEntry[]>;
}

/** The slice of a BullMQ `Queue` {@link drainQueue} reads. */
export interface DrainableQueue extends QueueLike {
  readonly client: Promise<EventStreamReader>;
  toKey(type: string): string;
  getJob(jobId: string): Promise<{ readonly failedReason?: string } | undefined>;
}

/**
 * Where a queue's events stream stood when {@link markQueueEvents} read it.
 * Carries the queue's name so a mark cannot be spent on another queue.
 */
export interface QueueEventMark {
  readonly queueName: string;
  readonly id: string;
}

/**
 * Marks the queue's events stream, for a later {@link drainQueue}. Take the
 * mark BEFORE the request that enqueues: anything written after it is the
 * drain's to account for, and anything before it is not.
 *
 * `0-0` stands for "no stream yet". BullMQ creates the stream with its first
 * event, and `obliterate` deletes it along with the queue.
 */
export async function markQueueEvents(queue: DrainableQueue): Promise<QueueEventMark> {
  const client = await queue.client;
  const [latest] = await client.xrevrange(queue.toKey('events'), '+', '-', 'COUNT', 1);

  return { queueName: queue.name, id: latest?.[0] ?? '0-0' };
}

export interface DrainQueueOptions {
  /** Budget for the expected jobs to finish. */
  readonly timeoutMs?: number;

  /** How long the queue must then hold at zero pending. */
  readonly settleMs?: number;

  readonly pollIntervalMs?: number;
}

/** A stream entry's flat `[field, value, ...]` list, as a record. */
function eventFields(fields: readonly string[]): Record<string, string | undefined> {
  const record: Record<string, string> = {};

  for (let index = 0; index + 1 < fields.length; index += 2) {
    record[fields[index] as string] = fields[index + 1] as string;
  }

  return record;
}

/**
 * Waits until `expected` jobs have finished on the queue since `mark`, and
 * throws the moment one fails. Needs a consumer: install `useWorker()` in the
 * spec file first, or nothing ever finishes.
 *
 * WHY THE EVENTS STREAM, not the pending count. With a live consumer a job can
 * be added and finished between two polls, so a count that reads zero may be
 * reading "not arrived yet". And a failed delivery is not pending either:
 * feedback jobs retry with backoff and keep their failures, so a count-based
 * drain would report one that exhausted its retries as drained. BullMQ writes
 * every `completed` and `failed` to `<queue>:events` in the same script that
 * finishes the job, so reading the stream from the mark misses neither.
 *
 * What it treats as failure:
 * - `failed`: a terminal failure. The reason is on the event.
 * - `delayed` for a job that was active: a failed attempt BullMQ scheduled for
 *   a retry with backoff. A retry writes no `failed` event; its reason is on
 *   the job. (`delayed` on its own is also how a job ADDED with a delay looks,
 *   which is why the job must have run first.)
 * - `waiting` with `prev: active`: a retry without backoff, or a stalled job
 *   BullMQ put back.
 * A spec that expects a job to fail should not drain it.
 *
 * Once `expected` jobs have finished, the queue must hold at zero pending for
 * `settleMs` (`waitForStableJobCount`), and the stream is read once more after
 * that window: a job that landed and finished inside it never moved the count.
 * Finishing more jobs than `expected` fails too, since for a producer under
 * test that means it enqueued more than it should have. An `expected` of 0 is
 * the negative case: nothing finishes, fails or stays pending across the window.
 *
 * `obliterate` deletes the stream, so a spec that obliterates the queue between
 * mark and drain loses the events and should mark again.
 */
export async function drainQueue(
  queue: DrainableQueue,
  mark: QueueEventMark,
  expected: number,
  options: DrainQueueOptions = {},
): Promise<void> {
  const { timeoutMs = 30_000, settleMs = 500, pollIntervalMs = 50 } = options;

  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`drainQueue: expected count must be >= 0 and an integer, got ${expected}`);
  }

  if (mark.queueName !== queue.name) {
    throw new Error(`drainQueue: this mark was taken on '${mark.queueName}', not '${queue.name}'`);
  }

  const client = await queue.client;
  const key = queue.toKey('events');
  const started = new Set<string>();
  let cursor = mark.id;
  let finished = 0;

  const retried = async (jobId: string, what: string): Promise<Error> => {
    const job = await queue.getJob(jobId);
    const reason = job?.failedReason ? `: ${job.failedReason}` : '';

    return new Error(`Queue '${queue.name}': job ${jobId} ${what} during the drain${reason}`);
  };

  const readNewEvents = async (): Promise<void> => {
    for (const [id, fields] of await client.xrange(key, cursor, '+')) {
      // XRANGE includes its start id, which is the last entry already read.
      if (id === cursor) {
        continue;
      }

      cursor = id;
      const entry = eventFields(fields);
      const jobId = entry['jobId'] ?? '(no job id)';

      switch (entry['event']) {
        case 'active':
          started.add(jobId);
          break;
        case 'completed':
          finished += 1;
          // Its id may be reused: the feedback producer's ids are deterministic
          // and `removeOnComplete` frees them, so a later delayed add under the
          // same id must not read as this job's retry.
          started.delete(jobId);
          break;
        case 'failed':
          throw new Error(
            `Queue '${queue.name}': job ${jobId} failed during the drain: ${entry['failedReason'] ?? '(no reason recorded)'}`,
          );
        case 'delayed':
          if (started.has(jobId)) {
            throw await retried(jobId, 'failed an attempt and was scheduled for a retry');
          }
          break;
        case 'waiting':
          if (entry['prev'] === 'active') {
            throw await retried(jobId, 'went back to waiting (a retry without backoff, or a stalled job)');
          }
          break;
      }
    }
  };

  const tooMany = (): Error =>
    new Error(
      `Queue '${queue.name}' finished ${finished} job(s) after the mark, but ${expected} were expected. ` +
        `More jobs were enqueued than the request under test should have produced.`,
    );

  const deadline = Date.now() + timeoutMs;
  await readNewEvents();

  while (finished < expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Queue '${queue.name}' finished ${finished} of ${expected} expected job(s) within ${timeoutMs}ms. ` +
          `If this spec file does not install useWorker(), nothing consumes the queue and nothing will finish.`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    await readNewEvents();
  }

  if (finished > expected) {
    throw tooMany();
  }

  try {
    await waitForStableJobCount(queue, 0, { timeoutMs: Math.max(deadline - Date.now(), 0), settleMs, pollIntervalMs });
  } catch (error) {
    // The count moved. When the stream can say why (a job failed, retried or
    // finished inside the window), that names the job and its reason, which
    // the count cannot.
    await readNewEvents();
    if (finished > expected) {
      throw tooMany();
    }

    throw error;
  }

  await readNewEvents();

  if (finished > expected) {
    throw tooMany();
  }
}

/**
 * Removes every job (any state) from the queue. Destructive on whatever server
 * `REDIS_BULLMQ_*` names, so the hooks that call it (`isolateQueue`,
 * `useWorker`) check the Redis ownership guard before they open the queue.
 */
export async function obliterateQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
