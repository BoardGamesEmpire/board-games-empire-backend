import { DataGatewayCapability } from '@bge/database';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { VOCABULARY_SECTION_JOB, VOCABULARY_SECTION_QUEUE } from './constants/vocabulary-section.constants';
import { VocabularySectionQueue } from './vocabulary-section.queue';

const { Search, Fetch, ListLanguages, ListPlatforms, ListCategories, ListMechanics } = DataGatewayCapability;

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

describe('VocabularySectionQueue', () => {
  let queue: { add: jest.Mock };
  let sections: VocabularySectionQueue;

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      providers: [VocabularySectionQueue, { provide: getQueueToken(VOCABULARY_SECTION_QUEUE), useValue: queue }],
    }).compile();

    sections = module.get(VocabularySectionQueue);
  });

  afterEach(() => jest.restoreAllMocks());

  /** The job ids and delays of the jobs queued, in order. */
  const queued = () =>
    queue.add.mock.calls.map(([, , options]: [string, unknown, { jobId: string; delay: number }]) => [
      options.jobId,
      options.delay,
    ]);

  it('queues one job per declared list capability, a minute apart, languages first (#718)', async () => {
    await sections.enqueue('g1', [Search, ListMechanics, ListLanguages, ListPlatforms], []);

    expect(queued()).toEqual([
      ['g1-ListLanguages', 0],
      ['g1-ListPlatforms', 60_000],
      ['g1-ListMechanics', 120_000],
    ]);
    for (const [name, data, options] of queue.add.mock.calls) {
      expect(name).toBe(VOCABULARY_SECTION_JOB);
      expect(options).toMatchObject(JOB_OPTIONS);
      expect(data).toMatchObject({
        gatewayId: 'g1',
        __meta: {
          actor: { kind: 'system', reason: 'gateway-registry:vocabulary-section' },
          correlationId: expect.any(String),
        },
      });
    }
    expect(queue.add.mock.calls.map(([, data]) => data.capability)).toEqual([
      ListLanguages,
      ListPlatforms,
      ListMechanics,
    ]);
  });

  it('leaves out a capability an admin switched off, without leaving a gap', async () => {
    await sections.enqueue('g1', [ListLanguages, ListPlatforms, ListCategories, ListMechanics], [ListPlatforms]);

    expect(queued()).toEqual([
      ['g1-ListLanguages', 0],
      ['g1-ListCategories', 60_000],
      ['g1-ListMechanics', 120_000],
    ]);
  });

  it('queues nothing for a DataGateway that declares no list', async () => {
    await sections.enqueue('g1', [Search, Fetch], []);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('logs and resolves when the queue refuses the job', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    queue.add.mockRejectedValueOnce(new Error('Redis is down')).mockResolvedValue({});

    await expect(sections.enqueue('g1', [ListLanguages, ListPlatforms], [])).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Redis is down'));
    // The next section is still queued.
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
