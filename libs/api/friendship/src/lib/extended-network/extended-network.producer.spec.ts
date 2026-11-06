import { AuditContextService } from '@bge/actor-context';
import { JOB_META_KEY } from '@bge/queue-actor-context';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EXTENDED_NETWORK_QUEUE, ExtendedNetworkJobNames } from './extended-network-queue.constants';
import { ExtendedNetworkProducer } from './extended-network.producer';

describe('ExtendedNetworkProducer (#497)', () => {
  const actor = { kind: 'user', userId: 'user-1' };

  let producer: ExtendedNetworkProducer;
  let queue: { add: jest.Mock };
  let currentActor: typeof actor | undefined;

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    currentActor = actor;

    const module = await Test.createTestingModule({
      providers: [
        ExtendedNetworkProducer,
        { provide: getQueueToken(EXTENDED_NETWORK_QUEUE), useValue: queue },
        {
          provide: AuditContextService,
          useValue: { getActor: () => currentActor, getCorrelationId: () => 'correlation-1' },
        },
      ],
    }).compile();

    producer = module.get(ExtendedNetworkProducer);
  });

  afterEach(() => jest.restoreAllMocks());

  // The job waits a moment before it runs, and a change to the same user that
  // lands meanwhile is merged into it: the job reads the friendships when it
  // runs, so a burst of accepts costs one rebuild. A change that lands while
  // it runs is kept by BullMQ and queued once it finishes. A failed rebuild is
  // retried before the daily rebuild has to repair it.
  it('queues one job per endpoint, merging repeated changes for a user (#497)', async () => {
    await producer.changed(['a', 'b']);

    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const [call, userId] of [
      [1, 'a'],
      [2, 'b'],
    ] as const) {
      expect(queue.add).toHaveBeenNthCalledWith(
        call,
        ExtendedNetworkJobNames.RebuildAround,
        expect.objectContaining({ userId }),
        {
          delay: 2000,
          deduplication: { id: `extended-network:${userId}`, keepLastIfActive: true },
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    }
  });

  // A rebuild that started before the change committed may have read the
  // friendships without it. With `keepLastIfActive` BullMQ stores the change
  // and queues one more job when the running one finishes. A `ttl` would be
  // ignored beside it.
  it('keeps a change made while its job runs, for one more job once that one finishes (#497)', async () => {
    await producer.changed(['a']);

    const [, , options] = queue.add.mock.calls[0];
    expect(options.deduplication).toEqual({ id: 'extended-network:a', keepLastIfActive: true });
  });

  // With `replace`, each change would swap the waiting job for a new one and
  // start its wait again, so changes to a user arriving faster than the wait
  // could put off their rebuild for as long as they kept coming.
  it('leaves a waiting job to run on time, whatever changes land while it waits (#497)', async () => {
    await producer.changed(['a']);

    const [, , options] = queue.add.mock.calls[0];
    expect(options.deduplication.replace).toBeFalsy();
  });

  it('carries the acting user and the correlation id to the worker, and reports nothing (#497)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await producer.changed(['a']);

    const [, data] = queue.add.mock.calls[0];
    expect(data).toEqual({ userId: 'a', [JOB_META_KEY]: { actor, correlationId: 'correlation-1' } });
    expect(warn).not.toHaveBeenCalled();
  });

  // A friendship change comes from a request, which always has an actor, so a
  // change without one is a bug: an entry point that sets none. Its rebuild
  // still runs, under a reason that says it is unattributed rather than as
  // the server's own work, and a warning reports it.
  it('reports a change with no actor, and still queues its rebuild under the unattributed reason (#497)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    currentActor = undefined;

    await producer.changed(['a', 'b']);

    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const [, data] of queue.add.mock.calls) {
      expect(data[JOB_META_KEY].actor).toEqual({ kind: 'system', reason: 'extended-network:unattributed-change' });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no actor'));
  });

  // The two jobs are independent, so one Redis round trip covers both.
  it("queues both endpoints' jobs side by side, not one after the other (#497)", async () => {
    let release: () => void = () => undefined;
    queue.add.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

    const changed = producer.changed(['a', 'b']);

    expect(queue.add).toHaveBeenCalledTimes(2);
    release();
    await changed;
  });

  it('queues once for a user named twice (#497)', async () => {
    await producer.changed(['a', 'a']);

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  // The friendship is already written. Failing the request now would tell the
  // user it wasn't, and the daily rebuild repairs the rows anyway.
  it('logs and swallows a queue failure, and still queues the other endpoint; the daily rebuild repairs it (#497)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    queue.add.mockRejectedValueOnce(new Error('connection lost'));

    await expect(producer.changed(['a', 'b'])).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenLastCalledWith(
      ExtendedNetworkJobNames.RebuildAround,
      expect.objectContaining({ userId: 'b' }),
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
});
