import { countPendingJobs, waitForStableJobCount, type QueueLike } from './queues';

/**
 * Unit coverage for the queue-inspection primitives (#262).
 *
 * These run against a scripted fake rather than a real BullMQ queue, on
 * purpose: what needs proving is the WAITING LOGIC — that a count which never
 * arrives fails loudly, and that one which arrives and then moves is caught —
 * and a real queue cannot be made to produce those sequences on demand. The
 * real-queue path is covered by the specs that consume it.
 *
 * `QueueLike` exists so this file can pass a plain object with no cast, the
 * same reasoning `household-wire.ts` gives for `HttpResponseLike`.
 */

/**
 * A queue whose pending count follows a script: one entry per poll, with the
 * last entry repeating forever. It answers whatever states `countPendingJobs`
 * asks for — deliberately not a fixed list, so adding a state there does not
 * strand this comment — reporting the scripted total under `waiting` and zero
 * for the rest, which is also what a real queue looks like with no worker
 * attached.
 */
function scriptedQueue(counts: readonly number[], name = 'scripted'): QueueLike & { polls: number } {
  const fake = {
    name,
    polls: 0,
    getJobCounts: (...types: string[]): Promise<Record<string, number>> => {
      const index = Math.min(fake.polls, counts.length - 1);
      fake.polls += 1;

      const waiting = counts[index] ?? 0;
      return Promise.resolve(Object.fromEntries(types.map((type) => [type, type === 'waiting' ? waiting : 0])));
    },
  };

  return fake;
}

// Small windows keep the suite fast; the logic under test is interval-agnostic.
const fast = { timeoutMs: 500, settleMs: 40, pollIntervalMs: 5 } as const;

describe('countPendingJobs', () => {
  it('sums every state that still owes processing', async () => {
    const queue: QueueLike = {
      name: 'summing',
      getJobCounts: (...types: string[]) =>
        Promise.resolve(Object.fromEntries(types.map((type, index) => [type, index + 1]))),
    };

    // Six states requested: waiting, paused, active, delayed, prioritized,
    // waiting-children — so 1+2+3+4+5+6.
    await expect(countPendingJobs(queue)).resolves.toBe(21);
  });

  it('counts jobs parked in the paused list', async () => {
    // Pausing RENAMES `wait` to `paused`, so a queue holding work reports zero
    // `waiting`. Omitting `paused` would make every negative assertion built on
    // this count pass with jobs still enqueued — latent while nothing pauses the
    // queue, and load-bearing as soon as the worker child (issue 348) does.
    const paused: QueueLike = {
      name: 'paused-queue',
      getJobCounts: (...types: string[]) =>
        Promise.resolve(Object.fromEntries(types.map((type) => [type, type === 'paused' ? 3 : 0]))),
    };

    await expect(countPendingJobs(paused)).resolves.toBe(3);
  });

  it('reports zero for an empty queue', async () => {
    await expect(countPendingJobs(scriptedQueue([0]))).resolves.toBe(0);
  });
});

describe('waitForStableJobCount', () => {
  it('resolves once the count arrives and then holds', async () => {
    // 0 → 0 → 1, then 1 forever: the arrival is late, and the settle window
    // sees nothing move afterwards.
    await expect(waitForStableJobCount(scriptedQueue([0, 0, 1]), 1, fast)).resolves.toBeUndefined();
  });

  it('resolves immediately for a count that is already correct', async () => {
    await expect(waitForStableJobCount(scriptedQueue([2]), 2, fast)).resolves.toBeUndefined();
  });

  it('rejects when the count never arrives, naming what it saw instead', async () => {
    await expect(waitForStableJobCount(scriptedQueue([0], 'feedback'), 1, fast)).rejects.toThrow(
      /'feedback'.*never reached 1.*last saw 0/s,
    );
  });

  it('rejects when the count overshoots during the settle window', async () => {
    // The failure this primitive exists for: one job arrives, the assertion
    // would pass on a single read, and a second job lands a moment later.
    await expect(waitForStableJobCount(scriptedQueue([1, 1, 2], 'feedback'), 1, fast)).rejects.toThrow(
      /'feedback'.*reached 1.*then moved to 2/s,
    );
  });

  it('rejects when the count drops away during the settle window', async () => {
    await expect(waitForStableJobCount(scriptedQueue([1, 1, 0]), 1, fast)).rejects.toThrow(/then moved to 0/);
  });

  it('proves a negative: zero stays zero across the settle window', async () => {
    // The replay-suppression assertion. There is no event to wait for, so the
    // whole budget is the settle window.
    await expect(waitForStableJobCount(scriptedQueue([0]), 0, fast)).resolves.toBeUndefined();
  });

  it('rejects when a job appears during a zero settle window', async () => {
    await expect(waitForStableJobCount(scriptedQueue([0, 0, 1]), 0, fast)).rejects.toThrow(/then moved to 1/);
  });

  it('actually polls through the settle window rather than reading once', async () => {
    const queue = scriptedQueue([1]);
    await waitForStableJobCount(queue, 1, fast);

    // settleMs / pollIntervalMs = 8 reads, plus the arrival read. A single-read
    // implementation would satisfy every assertion above but this one.
    expect(queue.polls).toBeGreaterThan(2);
  });

  it('rejects a negative expectation rather than waiting for the impossible', async () => {
    await expect(waitForStableJobCount(scriptedQueue([0]), -1, fast)).rejects.toThrow(/expected count must be >= 0/);
  });
});
