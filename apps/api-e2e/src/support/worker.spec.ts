import { E2E_OWNS_REDIS_VAR } from './e2e-env';
import { consumersOf, startWorker } from './worker';

/**
 * The refusal half of `useWorker`, reached through the function its
 * `beforeAll` calls. The message is the evidence the guard ran first: nothing
 * else on the way to a launch mentions `BGE_E2E_REDIS_FLUSH_OK`, and these
 * environments name no Redis host, so any step past the guard would fail on
 * the missing connection details instead. So no queue was emptied and no child
 * was spawned.
 *
 * The permitted path is not unit-tested here, because past the guard the only
 * thing left to test is a real launch. `harness/worker-drain.spec.ts` does that.
 */
describe('startWorker', () => {
  it('refuses a Redis the harness published as not its own', async () => {
    await expect(startWorker({ [E2E_OWNS_REDIS_VAR]: 'false' })).rejects.toThrow(
      /Refusing to empty the worker's queues and start a worker.*BGE_E2E_REDIS_FLUSH_OK=true/s,
    );
  });

  it('refuses when globalSetup never published ownership at all', async () => {
    await expect(startWorker({})).rejects.toThrow(/Refusing to empty the worker's queues/);
  });
});

/**
 * Readiness's count, against the two shapes `getWorkers` returns in bullmq
 * 5.76: parsed `CLIENT LIST` lines, and the placeholder it substitutes when the
 * server rejects the command.
 */
describe('consumersOf', () => {
  it('counts the worker connections BullMQ found in CLIENT LIST', async () => {
    // `getWorkers` overwrites `name` with the queue's and keeps the connection
    // name as `rawname`, so a count matching `name` against the connection
    // name would never see a consumer.
    const queue = {
      getWorkers: () =>
        Promise.resolve([{ name: 'feedback-delivery', rawname: 'bull:ZmVlZGJhY2stZGVsaXZlcnk=', cmd: 'bzpopmin' }]),
    };

    await expect(consumersOf(queue)).resolves.toBe(1);
  });

  it('does not count the placeholder for a server that rejects CLIENT', async () => {
    const queue = { getWorkers: () => Promise.resolve([{ name: 'GCP does not support client list' }]) };

    await expect(consumersOf(queue)).resolves.toBe(0);
  });
});
