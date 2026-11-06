import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { JOB_META_KEY } from '@bge/queue-actor-context';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { SCHEDULE_INTERVAL_OPTIONS, SCHEDULER_NAME } from '@nestjs/schedule/dist/schedule.constants';
import { Test } from '@nestjs/testing';
import { EXTENDED_NETWORK_QUEUE, ExtendedNetworkJobNames } from './extended-network-queue.constants';
import { ExtendedNetworkScheduleService } from './extended-network-schedule.service';

describe('ExtendedNetworkScheduleService (#497)', () => {
  const systemActor = { kind: 'system', reason: 'extended-network-rebuild' };

  let schedule: ExtendedNetworkScheduleService;
  let queue: { add: jest.Mock; setGlobalConcurrency: jest.Mock };
  let systemActorScope: { run: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined), setGlobalConcurrency: jest.fn().mockResolvedValue(1) };
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };

    const module = await Test.createTestingModule({
      providers: [
        ExtendedNetworkScheduleService,
        { provide: getQueueToken(EXTENDED_NETWORK_QUEUE), useValue: queue },
        { provide: SystemActorScope, useValue: systemActorScope },
        {
          provide: AuditContextService,
          useValue: { getActorOrThrow: () => systemActor, getCorrelationId: () => 'correlation-1' },
        },
      ],
    }).compile();

    schedule = module.get(ExtendedNetworkScheduleService);
  });

  afterEach(() => jest.restoreAllMocks());

  // A fixed job id would make BullMQ ignore every later add while a failed
  // run is kept, which would stop the daily rebuild for good. A deduplication
  // id merges only while a run is waiting or running, and is freed when it
  // ends, failed or not. Its priority lets a change's job that is queued
  // while it waits run first.
  const expectFullRebuildQueued = () => {
    expect(systemActorScope.run).toHaveBeenCalledWith('extended-network-rebuild', expect.any(Function));
    expect(queue.add).toHaveBeenCalledWith(
      ExtendedNetworkJobNames.RebuildAll,
      { [JOB_META_KEY]: { actor: systemActor, correlationId: 'correlation-1' } },
      {
        deduplication: { id: 'extended-network:rebuild-all' },
        priority: 10,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  };

  it('queues a full rebuild when the worker starts, as the system (#497)', async () => {
    await schedule.onApplicationBootstrap();

    expectFullRebuildQueued();
  });

  // The lock already keeps two rebuilds from running side by side. Held to
  // one job across the workers, the second waits in the queue rather than in
  // an open transaction.
  it('holds the extended network jobs to one at a time across workers when the worker starts (#497)', async () => {
    await schedule.onApplicationBootstrap();

    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
  });

  it('logs a failure to set the limit, and still queues the full rebuild (#497)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    queue.setGlobalConcurrency.mockRejectedValueOnce(new Error('connection lost'));

    await expect(schedule.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
    expectFullRebuildQueued();
  });

  it('queues a full rebuild every day, as the system (#497)', async () => {
    await schedule.rebuildDaily();

    expectFullRebuildQueued();
    expect(Reflect.getMetadata(SCHEDULER_NAME, ExtendedNetworkScheduleService.prototype.rebuildDaily)).toBe(
      'extended-network-rebuild',
    );
    expect(
      Reflect.getMetadata(SCHEDULE_INTERVAL_OPTIONS, ExtendedNetworkScheduleService.prototype.rebuildDaily),
    ).toEqual({ timeout: 24 * 60 * 60 * 1000 });
  });

  // The worker still starts. The next day's run, and every friendship
  // change's own job, keep the rows current meanwhile.
  it('logs a queue failure at start and lets the worker start (#497)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    queue.add.mockRejectedValueOnce(new Error('connection lost'));

    await expect(schedule.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
});
