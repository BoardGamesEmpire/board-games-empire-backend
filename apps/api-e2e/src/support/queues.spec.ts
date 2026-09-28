import {
  countPendingJobs,
  drainQueue,
  markQueueEvents,
  testQueueConnection,
  waitForStableJobCount,
  type DrainableQueue,
  type QueueLike,
} from './queues';

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

describe('testQueueConnection', () => {
  const published = { REDIS_BULLMQ_HOST: 'redis.test', REDIS_BULLMQ_PORT: '6380', REDIS_BULLMQ_DATABASE: '2' };

  it('connects over plaintext when the harness published no TLS', () => {
    expect(testQueueConnection(published)).toEqual({
      host: 'redis.test',
      port: 6380,
      db: 2,
      username: undefined,
      password: undefined,
    });
  });

  it('offers TLS when the queue connection has it, as the worker child does', () => {
    // `BGE_E2E_REDIS_URL=rediss://…` publishes REDIS_BULLMQ_TLS_ENABLED=true.
    // Without it these handles would offer plaintext to a TLS port and retry
    // forever, while the worker beside them had connected.
    const connection = testQueueConnection({
      ...published,
      REDIS_BULLMQ_TLS_ENABLED: 'true',
      REDIS_BULLMQ_TLS_CA: 'queue-ca',
    });

    expect(connection.tls).toEqual({ ca: 'queue-ca', cert: undefined, key: undefined, rejectUnauthorized: true });
  });

  it('refuses an environment globalSetup never published', () => {
    expect(() => testQueueConnection({})).toThrow(/did the e2e globalSetup run/);
  });
});

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
    // Pausing RENAMEs `wait` to `paused`, so a queue holding work reports zero
    // under `wait`. What this pins is that the sum INCLUDES a paused count when
    // one comes back — not that the production call would miss it without the
    // explicit argument. It would not: `sanitizeJobTypes` adds `paused` for any
    // request containing `waiting`. See the note on `countPendingJobs` for why
    // the argument is spelled out regardless.
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

/**
 * One entry on a queue's events stream, as BullMQ writes it: an event name and
 * its fields. The fake below assigns the stream ids.
 */
type StreamEvent = Readonly<Record<string, string>> & { readonly event: string };

interface ScriptedStreamOptions {
  /** Entries already on the stream before the test takes its mark. */
  readonly before?: readonly StreamEvent[];

  /**
   * What lands between reads: batch N is appended just before the Nth
   * `xrange`, and reads past the end find nothing new. A single batch holding
   * `added`, `active` and `completed` is a job that came and went between two
   * polls.
   */
  readonly arrivals?: readonly (readonly StreamEvent[])[];

  /** The pending count `getJobCounts` reports, scripted as in `scriptedQueue`. */
  readonly pending?: readonly number[];

  /** `failedReason` per job id, as a retried job's hash carries it. */
  readonly failedReasons?: Readonly<Record<string, string>>;
}

/**
 * A queue with a scripted events stream, for the drain.
 *
 * `xrange` includes its start id, as Redis's does, so a drain that forgot to
 * skip the entry at its own cursor would count it twice here as well. Every
 * read checks the key, so a drain reading the wrong stream fails rather than
 * passing on an empty one.
 */
function scriptedStream(name: string, options: ScriptedStreamOptions = {}): DrainableQueue & { reads: number } {
  const key = `bull:${name}:events`;
  const stream: [id: string, fields: string[]][] = [];
  let sequence = 0;

  const append = (events: readonly StreamEvent[]): void => {
    for (const event of events) {
      sequence += 1;
      stream.push([`${1_000 + sequence}-0`, Object.entries(event).flat()]);
    }
  };

  const idValue = (id: string): number => Number(id.split('-')[0]);
  const requireKey = (requested: string): void => {
    if (requested !== key) {
      throw new Error(`read ${requested}, expected ${key}`);
    }
  };

  append(options.before ?? []);

  const counts = scriptedQueue(options.pending ?? [0], name);
  const fake = {
    name,
    reads: 0,
    getJobCounts: counts.getJobCounts,
    toKey: (type: string) => `bull:${name}:${type}`,
    getJob: (jobId: string) => {
      const failedReason = options.failedReasons?.[jobId];
      return Promise.resolve(failedReason === undefined ? undefined : { failedReason });
    },
    client: Promise.resolve({
      xrange: (requested: string, start: string, end: string) => {
        requireKey(requested);
        expect(end).toBe('+');

        append(options.arrivals?.[fake.reads] ?? []);
        fake.reads += 1;

        return Promise.resolve(stream.filter(([id]) => idValue(id) >= idValue(start)));
      },
      xrevrange: (requested: string, end: string, start: string, countToken: 'COUNT', count: number) => {
        requireKey(requested);
        expect([end, start, countToken, count]).toEqual(['+', '-', 'COUNT', 1]);

        return Promise.resolve(stream.slice(-1));
      },
    }),
  };

  return fake;
}

const completedJob = (jobId: string): StreamEvent[] => [
  { event: 'added', jobId, name: 'deliver' },
  { event: 'waiting', jobId },
  { event: 'active', jobId, prev: 'waiting' },
  { event: 'completed', jobId, returnvalue: 'null', prev: 'active' },
];

// As with `fast` above: small windows, interval-agnostic logic.
const drainFast = { timeoutMs: 300, settleMs: 30, pollIntervalMs: 5 } as const;

describe('markQueueEvents', () => {
  it('marks the latest entry on the stream', async () => {
    const queue = scriptedStream('feedback', { before: completedJob('old') });

    await expect(markQueueEvents(queue)).resolves.toEqual({ queueName: 'feedback', id: '1004-0' });
  });

  it('marks the start for a queue that has no stream yet', async () => {
    // BullMQ creates the stream with its first event, and `obliterate` deletes
    // it, so an absent stream is the normal state at a file's start.
    await expect(markQueueEvents(scriptedStream('feedback'))).resolves.toEqual({ queueName: 'feedback', id: '0-0' });
  });
});

describe('drainQueue', () => {
  it('resolves once the expected job finishes after the mark', async () => {
    const queue = scriptedStream('feedback', { arrivals: [[], completedJob('j1')] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).resolves.toBeUndefined();
  });

  it('counts a job that arrived and finished between two reads', async () => {
    // The case a pending-count drain cannot see: the count is zero before the
    // job lands and zero again after it finishes, so polling it passes before
    // anything has happened. The stream keeps the completion.
    const queue = scriptedStream('feedback', { arrivals: [completedJob('j1')], pending: [0] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).resolves.toBeUndefined();
  });

  it('ignores everything at or before the mark', async () => {
    // A failure from an earlier test is on the stream, and so is a completion
    // that would satisfy the count on its own. Neither belongs to this drain.
    const queue = scriptedStream('feedback', {
      before: [
        { event: 'active', jobId: 'old-fail', prev: 'waiting' },
        { event: 'failed', jobId: 'old-fail', failedReason: 'from an earlier test', prev: 'active' },
        ...completedJob('old'),
      ],
      arrivals: [completedJob('j1')],
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).resolves.toBeUndefined();
  });

  it('does not count the entry at its own cursor twice', async () => {
    // Two completions are expected and the stream only ever holds one after
    // the mark, so re-reading the entry at the cursor is the only way to pass.
    const queue = scriptedStream('feedback', { arrivals: [completedJob('j1')] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 2, drainFast)).rejects.toThrow(/finished 1 of 2/);
  });

  it('throws on a terminal failure, naming the job and its reason', async () => {
    const queue = scriptedStream('feedback', {
      arrivals: [
        [
          { event: 'active', jobId: 'j1', prev: 'waiting' },
          { event: 'failed', jobId: 'j1', failedReason: 'sink exploded', prev: 'active' },
          { event: 'retries-exhausted', jobId: 'j1', attemptsMade: '1' },
        ],
      ],
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/'feedback'.*j1 failed.*sink exploded/s);
  });

  it('throws on a retry with backoff, with the reason the job recorded', async () => {
    // A failed attempt that will be retried writes no `failed` event: BullMQ
    // moves the job to `delayed`, and the reason is on the job, not the stream.
    const queue = scriptedStream('feedback', {
      arrivals: [
        [
          { event: 'active', jobId: 'j1', prev: 'waiting' },
          { event: 'delayed', jobId: 'j1', delay: '2000' },
        ],
      ],
      failedReasons: { j1: 'sink timed out' },
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/'feedback'.*j1.*retry.*sink timed out/s);
  });

  it('throws on a retry without backoff', async () => {
    const queue = scriptedStream('feedback', {
      arrivals: [
        [
          { event: 'active', jobId: 'j1', prev: 'waiting' },
          { event: 'waiting', jobId: 'j1', prev: 'active' },
        ],
      ],
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/'feedback'.*j1.*back to waiting/s);
  });

  it('does not mistake a job added with a delay for a retry', async () => {
    // `delayed` also means "added with a delay". Only a job that was active
    // first is being retried.
    const queue = scriptedStream('feedback', {
      arrivals: [
        [
          { event: 'added', jobId: 'j1', name: 'deliver' },
          { event: 'delayed', jobId: 'j1', delay: '10' },
        ],
        completedJob('j1').slice(2),
      ],
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).resolves.toBeUndefined();
  });

  it('rejects when the job never finishes, naming the count it reached', async () => {
    const queue = scriptedStream('feedback', { pending: [1] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/'feedback' finished 0 of 1.*useWorker/s);
  });

  it('rejects when more jobs finish than were expected', async () => {
    const queue = scriptedStream('feedback', { arrivals: [[...completedJob('j1'), ...completedJob('j2')]] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(
      /'feedback' finished 2 job\(s\).*1 were expected/s,
    );
  });

  it('rejects when another job finishes while the queue holds at zero', async () => {
    // The final read after the hold. A job that lands and finishes inside the
    // settle window never moves the pending count, so only the stream shows it.
    const queue = scriptedStream('feedback', { arrivals: [completedJob('j1'), completedJob('j2')] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/'feedback' finished 2 job\(s\)/);
  });

  it('names a retry that happens during the hold, rather than the count it moved', async () => {
    // The count moves from 0 to 1 inside the settle window. The stream says
    // why, and that is the message worth having: the job and its reason.
    const queue = scriptedStream('feedback', {
      arrivals: [
        completedJob('j1'),
        [
          { event: 'active', jobId: 'j2', prev: 'waiting' },
          { event: 'delayed', jobId: 'j2', delay: '2000' },
        ],
      ],
      pending: [0, 1],
      failedReasons: { j2: 'second delivery failed' },
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/j2.*retry.*second delivery failed/s);
  });

  it('does not read a reused job id as a retry once its first job completed', async () => {
    // Deterministic ids plus `removeOnComplete` make this reachable: the id is
    // free again the moment the first job finishes.
    const reused = 'feedback:report:local';
    const queue = scriptedStream('feedback', {
      arrivals: [
        [
          ...completedJob(reused),
          { event: 'added', jobId: reused, name: 'deliver' },
          { event: 'delayed', jobId: reused, delay: '10' },
        ],
      ],
    });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).resolves.toBeUndefined();
  });

  it('rejects when work is still pending after the expected job finished', async () => {
    const queue = scriptedStream('feedback', { arrivals: [completedJob('j1')], pending: [1] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 1, drainFast)).rejects.toThrow(/never reached 0 pending/);
  });

  it('proves a negative: nothing finishes and nothing is pending', async () => {
    const queue = scriptedStream('feedback');
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 0, drainFast)).resolves.toBeUndefined();
  });

  it('rejects an expected zero once anything finishes', async () => {
    const queue = scriptedStream('feedback', { arrivals: [completedJob('j1')] });
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, 0, drainFast)).rejects.toThrow(/finished 1 job\(s\).*0 were expected/s);
  });

  it('refuses a mark taken on another queue', async () => {
    const mark = await markQueueEvents(scriptedStream('webhooks'));

    await expect(drainQueue(scriptedStream('feedback'), mark, 1, drainFast)).rejects.toThrow(
      /mark was taken on 'webhooks'/,
    );
  });

  it('rejects an expectation that is not a whole number of jobs', async () => {
    const queue = scriptedStream('feedback');
    const mark = await markQueueEvents(queue);

    await expect(drainQueue(queue, mark, -1, drainFast)).rejects.toThrow(/expected count must be >= 0/);
    await expect(drainQueue(queue, mark, 1.5, drainFast)).rejects.toThrow(/expected count must be >= 0/);
  });
});
