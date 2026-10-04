import { QueueNames } from '@bge/game-import';
import { FEEDBACK_QUEUE_NAME } from '@bge/queue-feedback';
import { WEBHOOK_QUEUE_NAME } from '@bge/queue-webhooks';
import {
  E2E_VERBOSE_VAR,
  launchChild,
  requireBundle,
  stopChild,
  withChildOutput,
  WORKSPACE_ROOT,
} from '@bge/testing-e2e/child-process';
import type { Queue } from 'bullmq';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { workerEnvOverrides } from './e2e-env';
import { emptyQueue } from './queue-isolation';
import { createTestQueue, type TestQueue } from './queues';
import { requireDisposableRedis } from './redis-reset';

/** Built by the e2e target's `worker:build` dependency. */
const WORKER_BUNDLE = path.join(WORKSPACE_ROOT, 'apps', 'worker', 'dist', 'main.js');

/** Matches the API launch's budget; a worker boot measured under a second locally (#268). */
const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_MS = 100;

/**
 * Every queue `apps/worker` consumes: one per `@Processor` in the consumer
 * modules `worker.module.ts` imports. `{bge.gateway.fetch}` is not here,
 * because `apps/gateway-worker` consumes it. Nothing empties it, then, and a
 * worker suite that ran a game import would leave its fetch jobs there.
 *
 * The names are imported from the libs that declare them, so a rename reaches
 * here. The media sweep's is the exception: `@bge/media` does not export its
 * queue constants, so it is spelled out.
 *
 * The list checks itself in one direction. Readiness waits for a consumer on
 * EVERY queue here, so a renamed or retired queue fails the launch and names
 * the queue. What it cannot catch is a queue the worker gained and this list
 * did not; that queue's leftovers would reach the worker unemptied.
 */
export const WORKER_QUEUE_NAMES = [
  FEEDBACK_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
  QueueNames.GamesImport,
  '{bge.media.contribution-sweep}',
] as const;

export type WorkerQueueName = (typeof WORKER_QUEUE_NAMES)[number];

export interface StartedWorker {
  readonly child: ChildProcess;

  /**
   * The test-owned handle on one of the worker's queues, for marks and drains.
   * Throws, with the worker's output, if the worker has exited since launch.
   */
  queue(name: WorkerQueueName): Queue;

  /**
   * Stops the child, then empties its queues and closes the handles. Throws
   * afterwards if the worker had already exited on its own.
   */
  stop(): Promise<void>;
}

/**
 * Consumers attached to a queue, from BullMQ's worker list.
 *
 * Not `getWorkersCount()`. On a server that rejects `CLIENT` as an unknown
 * command, BullMQ returns a placeholder entry (`{ name: 'GCP does not support
 * client list' }`) instead of an error, and the count reads 1 with nothing
 * attached. A real entry is a `CLIENT LIST` line `getWorkers` matched by its
 * connection name, which it keeps as `rawname` while overwriting `name` with
 * the queue's (bullmq 5.76). The placeholder has no `rawname`, so counting only
 * entries that do turns a server hiding its clients into "not ready", and the
 * launch timeout then names the likely cause.
 */
export async function consumersOf(queue: Pick<Queue, 'getWorkers'>): Promise<number> {
  const workers = await queue.getWorkers();

  return workers.filter((entry) => entry['rawname'] !== undefined).length;
}

/**
 * Empties every queue, and lets each one finish before reporting any failure.
 * With `Promise.all`, the first rejection would reach the caller's cleanup
 * while the other queues were still mid-obliterate (BullMQ pauses the queue,
 * then deletes it), and closing their handles there would leave them paused
 * with their jobs.
 */
async function emptyEvery(handles: Iterable<TestQueue>): Promise<void> {
  const results = await Promise.allSettled([...handles].map((handle) => emptyQueue(handle.queue)));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));

  if (failures.length === 1) {
    throw failures[0];
  }

  if (failures.length > 1) {
    throw new Error(
      failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('\n'),
    );
  }
}

/**
 * Launches `apps/worker` as a child process and resolves once it has attached
 * a consumer to every queue it serves. The body of {@link useWorker}'s
 * `beforeAll`, exported so the guard can be unit-tested without hooks.
 *
 * Steps, in order:
 * 1. The Redis ownership guard. Refuses, by throwing, a Redis the harness did
 *    not provision unless `BGE_E2E_REDIS_FLUSH_OK=true` says it is disposable.
 * 2. Test-owned handles on every queue in {@link WORKER_QUEUE_NAMES}.
 * 3. Each queue emptied, so the worker never inherits another file's leftovers.
 *    It would process them, against whatever this file has put in the database.
 * 4. The launch, with the API child's output contract (`launchChild`).
 *
 * Ready means a consumer is attached to every queue, so a job enqueued from
 * here on will be taken. BullMQ lists consumers from `CLIENT LIST`, by the name
 * each worker connection sets with `CLIENT SETNAME`. Some managed Redis servers
 * block one or the other, which only the `BGE_E2E_REDIS_URL` escape hatch can
 * reach. The launch then fails and says so: at once when the server refuses
 * the command outright, or at the timeout when it answers without names.
 *
 * Ready comes before the worker has finished booting. Its consumers attach
 * while its modules initialize, ahead of its later bootstrap hooks and its
 * "started" log line. The worker can still die after that, so every later
 * `queue()` and the final `stop()` check that it is still running.
 */
export async function startWorker(env: NodeJS.ProcessEnv = process.env): Promise<StartedWorker> {
  requireDisposableRedis(`empty the worker's queues and start a worker`, env);
  requireBundle('worker', WORKER_BUNDLE, '@boardgamesempire/worker:build');

  const verbose = env[E2E_VERBOSE_VAR] === 'true';
  const handles = new Map<WorkerQueueName, TestQueue>();
  const closeHandles = async (): Promise<void> => {
    await Promise.allSettled([...handles.values()].map((handle) => handle.close()));
    handles.clear();
  };

  try {
    for (const name of WORKER_QUEUE_NAMES) {
      handles.set(name, createTestQueue(name, env));
    }

    await emptyEvery(handles.values());

    let unattached: readonly string[] = WORKER_QUEUE_NAMES;
    const outcome = await launchChild({
      label: 'worker',
      bundle: WORKER_BUNDLE,
      env: { ...env, ...workerEnvOverrides() },
      verbose,
      isReady: async () => {
        const counts = await Promise.all(
          [...handles].map(async ([name, handle]) => {
            try {
              return [name, await consumersOf(handle.queue)] as const;
            } catch (error) {
              throw new Error(
                `could not list consumers on '${name}' through CLIENT LIST ` +
                  `(${error instanceof Error ? error.message : String(error)})`,
              );
            }
          }),
        );

        unattached = counts.filter(([, count]) => count === 0).map(([name]) => name);
        return unattached.length === 0;
      },
      describeWait: () =>
        `no consumer attached yet on ${unattached.map((name) => `'${name}'`).join(', ')}. A queue the worker ` +
        `never attaches to may have been renamed or moved to another app (see WORKER_QUEUE_NAMES); on the ` +
        `BGE_E2E_REDIS_URL escape hatch, the server may block the CLIENT SETNAME/LIST this check reads`,
      timeoutMs: READINESS_TIMEOUT_MS,
      pollMs: READINESS_POLL_MS,
    });

    if (outcome.kind !== 'ready') {
      throw new Error(outcome.failure);
    }

    const { child, outputTail } = outcome;

    const exitedEarly = (): Error | undefined => {
      if (child.exitCode === null && child.signalCode === null) {
        return undefined;
      }

      return new Error(
        withChildOutput(
          `The worker exited while its spec file was still using it ` +
            `(code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
          verbose,
          outputTail,
        ),
      );
    };

    return {
      child,
      queue: (name) => {
        const died = exitedEarly();
        if (died !== undefined) {
          throw died;
        }

        const handle = handles.get(name);
        if (handle === undefined) {
          throw new Error(`The worker has stopped; its '${name}' queue handle is closed`);
        }

        return handle.queue;
      },
      stop: async () => {
        const died = exitedEarly();

        try {
          await stopChild(child);

          // After the child, not before: a forced obliterate would take jobs
          // out from under a running consumer. What it clears here is anything
          // left pending by a drain that threw (a retry waiting out its
          // backoff) and anything the worker scheduled on its own.
          await emptyEvery(handles.values());
        } finally {
          await closeHandles();
        }

        if (died !== undefined) {
          throw died;
        }
      },
    };
  } catch (error) {
    await closeHandles();
    throw error;
  }
}

/**
 * Runs the real `apps/worker` beside the API for one spec file: started in
 * `beforeAll`, stopped in `afterAll` (SIGTERM, then SIGKILL), as the API child
 * is for the run. Returns an accessor for the worker's queues, to take marks on
 * and drain.
 *
 * ```ts
 * const workerQueue = useWorker();
 *
 * it('delivers', async () => {
 *   const queue = workerQueue(FEEDBACK_QUEUE_NAME);
 *   const mark = await markQueueEvents(queue);
 *   await post(actor, payload).expect(201);
 *   await drainQueue(queue, mark, 1);
 * });
 * ```
 *
 * Opt-in, because the suite's baseline is no consumer at all: other files
 * assert on jobs sitting in `waiting`, and a worker running for them would take
 * those jobs. Per file rather than per run for the same reason. The cost is one
 * worker boot per file that installs this.
 *
 * BETWEEN TESTS nothing is cleared, because a forced obliterate would remove
 * jobs the worker is holding. A drain that returns leaves its queue empty; one
 * that throws leaves its job behind, and a retry waiting out its backoff fails
 * the next drain's hold at zero. A test that expects a drain to throw removes
 * that job itself. For the same reason, do not also `isolateQueue` a queue
 * listed here.
 *
 * `afterAll` also stops a worker whose start outlived `beforeAll`'s timeout,
 * so a slow launch cannot leave a consumer running into later files. There is
 * no exit-hook fallback as the API child has (see `killOnExit`): a Jest process
 * that dies without running `afterAll` can orphan the worker.
 */
export function useWorker(): (name: WorkerQueueName) => Queue {
  let starting: Promise<StartedWorker> | undefined;
  let worker: StartedWorker | undefined;

  beforeAll(async () => {
    starting = startWorker();
    worker = await starting;
  });

  afterAll(async () => {
    const pending = starting;
    starting = undefined;
    worker = undefined;

    // A start that failed has already cleaned up after itself, and
    // `beforeAll` reported why.
    const started = await pending?.catch(() => undefined);
    await started?.stop();
  });

  return (name) => {
    if (worker === undefined) {
      throw new Error('The worker is not running — useWorker() starts it in beforeAll');
    }

    return worker.queue(name);
  };
}
