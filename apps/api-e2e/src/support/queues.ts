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
 * running the worker app and lands with the feedback idempotency suite
 * (#262); the wait/obliterate primitives below are the building blocks it
 * composes.
 */

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

/** Jobs still owed processing: everything except completed/failed. */
export async function countPendingJobs(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
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

/** Removes every job (any state) from the queue. */
export async function obliterateQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
